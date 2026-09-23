import {
  AIProvider,
  DocumentAnalysisResult,
  DocumentInput,
  ExtractionPromptContext,
  ProviderHealth,
  ProviderOptions,
} from '../../src/providers/ai/AIProvider';
import { ChatMessage, ChatOptions, ChatResponse, ChatStreamChunk } from '../../src/domain/chat';
import { RawFinancialExtraction } from '../../src/extraction/schemas/financialSchema';

export class MockAIProvider implements AIProvider {
  public readonly providerName = 'mock';

  public mockExtractionData: RawFinancialExtraction = {
    documentType: 'invoice',
    invoiceNumber: 'INV-2024-001',
    documentNumber: 'DOC-9988',
    invoiceDate: '2024-05-15',
    dueDate: '2024-06-15',
    purchaseOrderNumber: 'PO-77889',
    referenceNumbers: ['REF-1234'],
    currency: 'USD',
    language: 'en',
    pageCount: 1,
    vendor: {
      name: 'Acme Cloud Technologies Inc.',
      address: '100 Innovation Way, Suite 400, San Francisco, CA 94105',
      taxId: 'US-94-1234567',
      email: 'billing@acmecloud.com',
      phone: '+1-415-555-0199',
      contactPerson: 'Jane Doe',
    },
    customer: {
      name: 'Enterprise Logistics Global',
      address: '500 Commerce Blvd, New York, NY 10001',
      taxId: 'US-13-7654321',
      email: 'ap@enterpriselogistics.com',
      phone: '+1-212-555-0144',
      contactPerson: 'John Smith',
    },
    lineItems: [
      {
        lineNumber: 1,
        description: 'Cloud Infrastructure Hosting - Dedicated Cluster',
        sku: 'HOST-DED-01',
        quantity: 2,
        unit: 'months',
        unitPrice: 1500.0,
        discount: 0,
        taxRate: 0.1,
        taxAmount: 300.0,
        lineSubtotal: 3000.0,
        lineTotal: 3300.0,
      },
      {
        lineNumber: 2,
        description: 'Premium SLA 24/7 Technical Support',
        sku: 'SUPP-PREM',
        quantity: 1,
        unit: 'package',
        unitPrice: 500.0,
        discount: 50.0,
        taxRate: 0.1,
        taxAmount: 45.0,
        lineSubtotal: 450.0,
        lineTotal: 495.0,
      },
    ],
    totals: {
      subtotal: 3450.0,
      discountTotal: 50.0,
      taxTotal: 345.0,
      taxesBreakdown: [
        {
          name: 'State Sales Tax (10%)',
          rate: 0.1,
          amount: 345.0,
        },
      ],
      shippingCharges: 0,
      additionalCharges: 0,
      rounding: 0,
      grandTotal: 3795.0,
      paidAmount: 1000.0,
      balanceDue: 2795.0,
    },
    payment: {
      paymentTerms: 'Net 30',
      dueDate: '2024-06-15',
      paymentMethod: 'Wire Transfer / ACH',
      bankDetails: {
        bankName: 'Silicon Valley Commercial Bank',
        accountNumber: '9876543210',
        routingNumber: '121000358',
        iban: null,
        swiftBic: 'SVCBUS33',
      },
      paymentReference: 'INV-2024-001',
    },
  };

  public shouldFail = false;
  public failureMessage = 'Simulated Provider Failure';
  public extractCallCount = 0;
  public customExtractHandler?: (
    doc: DocumentInput,
    promptContext: ExtractionPromptContext,
    options?: ProviderOptions,
    callCount?: number
  ) => unknown | Promise<unknown>;

  public async analyzeDocument(
    _doc: DocumentInput,
    _options?: ProviderOptions
  ): Promise<DocumentAnalysisResult> {
    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }
    return {
      detectedType: 'invoice',
      summary: 'Mock invoice analysis completed',
      pageCountEstimate: 1,
    };
  }

  public async extractStructuredData<T>(
    doc: DocumentInput,
    promptContext: ExtractionPromptContext,
    options?: ProviderOptions
  ): Promise<T> {
    this.extractCallCount++;
    if (options?.onInvocation) {
      options.onInvocation({
        provider: this.providerName,
        model: options.model || 'mock-model',
        purpose: options.purpose || 'EXTRACTION',
        attempt: this.extractCallCount,
        durationMs: 10,
        timestamp: new Date().toISOString(),
        outcome: 'SUCCESS',
      });
    }
    if (this.customExtractHandler) {
      return (await this.customExtractHandler(doc, promptContext, options, this.extractCallCount)) as T;
    }
    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }
    if (options?.purpose === 'VERIFICATION' || promptContext.userPrompt.includes('SECOND-PASS')) {
      return {
        isVerified: true,
        confidenceScore: 1.0,
        issuesFound: [],
        correctionsNeeded: [],
        verifierNotes: 'Mock second-pass verification passed with no discrepancies.',
      } as unknown as T;
    }
    return this.mockExtractionData as unknown as T;
  }

  public async chat(
    messages: ChatMessage[],
    _options?: ChatOptions
  ): Promise<ChatResponse> {
    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }
    const lastMsg = messages[messages.length - 1]?.content || 'Hello';
    return {
      role: 'assistant',
      content: `Mock AI response to: ${lastMsg}`,
      model: 'mock-model',
      usage: {
        promptTokens: 10,
        completionTokens: 15,
        totalTokens: 25,
      },
    };
  }

  public async *streamChat(
    messages: ChatMessage[],
    _options?: ChatOptions
  ): AsyncIterable<ChatStreamChunk> {
    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }
    yield { text: 'Mock ', isComplete: false };
    yield { text: 'streaming ', isComplete: false };
    yield { text: 'response.', isComplete: false };
    yield { text: '', isComplete: true };
  }

  public async healthCheck(): Promise<ProviderHealth> {
    return {
      isHealthy: !this.shouldFail,
      provider: this.providerName,
      latencyMs: 5,
    };
  }
}
