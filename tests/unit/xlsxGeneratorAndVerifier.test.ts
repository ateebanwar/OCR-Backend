import { describe, it, expect } from 'vitest';
import { generateFinancialWorkbook } from '../../src/spreadsheet/xlsxGenerator';
import { verifyXlsxBuffer } from '../../src/spreadsheet/xlsxVerifier';
import { CanonicalFinancialDocument } from '../../src/domain/financial';
import { FinancialReconciliationReport } from '../../src/domain/processing';

describe('XLSX Generation & Round-Trip Verification', () => {
  const mockDoc: CanonicalFinancialDocument = {
    documentId: 'test-doc-123',
    sourceFilename: 'invoice-sample.pdf',
    documentHash: 'a1b2c3d4e5f6',
    documentType: 'invoice',
    invoiceNumber: 'INV-8899',
    documentNumber: null,
    invoiceDate: '2024-04-10',
    dueDate: '2024-05-10',
    purchaseOrderNumber: 'PO-4455',
    referenceNumbers: [],
    currency: 'USD',
    language: 'en',
    processingTimestamp: new Date().toISOString(),
    vendor: {
      name: 'Global Tech Suppliers Inc.',
      address: '742 Evergreen Terrace',
      taxId: 'US-99-887766',
      email: 'sales@globaltech.com',
      phone: '+1-555-0192',
      contactPerson: 'Alice Green',
    },
    customer: {
      name: 'Modern Solutions Corp',
      address: '100 Main St, Austin, TX',
      taxId: 'US-11-223344',
      email: 'ap@modernsolutions.io',
      phone: '+1-555-0199',
      contactPerson: 'Bob Brown',
    },
    lineItems: [
      {
        lineNumber: 1,
        description: 'Server Blade Replacement Module',
        sku: 'SRV-BLD-01',
        quantity: 4,
        unit: 'ea',
        unitPrice: 450.0,
        discount: 50.0,
        taxRate: 0.08,
        taxAmount: 140.0,
        lineSubtotal: 1750.0,
        lineTotal: 1890.0,
      },
    ],
    totals: {
      subtotal: 1750.0,
      discountTotal: 50.0,
      taxTotal: 140.0,
      taxesBreakdown: [{ name: 'State Tax', rate: 0.08, amount: 140.0 }],
      shippingCharges: 25.0,
      additionalCharges: 0,
      rounding: 0,
      grandTotal: 1915.0,
      paidAmount: 500.0,
      balanceDue: 1415.0,
    },
    payment: {
      paymentTerms: 'Net 30',
      dueDate: '2024-05-10',
      paymentMethod: 'Wire',
      bankDetails: {
        bankName: 'City Bank',
        accountNumber: '1122334455',
        routingNumber: '021000021',
        iban: null,
        swiftBic: null,
      },
      paymentReference: 'INV-8899',
    },
    coverage: {
      totalPages: 1,
      processedPages: 1,
      extractedPages: [1],
      failedPages: [],
      skippedPages: [],
      extractionCompleteness: 1.0,
      isFullyCovered: true,
    },
  };

  const mockRecon: FinancialReconciliationReport = {
    documentId: 'test-doc-123',
    reconciledAt: new Date().toISOString(),
    overallStatus: 'EXACT_MATCH',
    isVerified: true,
    toleranceApplied: 0.0,
    currency: 'USD',
    currencyPrecision: 2,
    lineItems: [],
    totals: {
      calculatedSubtotal: 1750.0,
      extractedSubtotal: 1750.0,
      subtotalVariance: 0,
      calculatedTaxTotal: 140.0,
      extractedTaxTotal: 140.0,
      taxVariance: 0,
      calculatedGrandTotal: 1915.0,
      extractedGrandTotal: 1915.0,
      grandTotalVariance: 0,
      calculatedBalanceDue: 1415.0,
      extractedBalanceDue: 1415.0,
      balanceDueVariance: 0,
      status: 'EXACT_MATCH',
      discrepancies: [],
      isVerified: true,
    },
    discrepancies: [],
    auditNotes: ['All values reconciled perfectly.'],
  };

  it('generates a valid, non-empty Excel buffer', async () => {
    const buffer = await generateFinancialWorkbook(mockDoc, mockRecon);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('round-trip verifies the generated XLSX structure and formulas', async () => {
    const buffer = await generateFinancialWorkbook(mockDoc, mockRecon);
    const verification = await verifyXlsxBuffer(buffer);

    expect(verification.isValid).toBe(true);
    expect(verification.sheetNames).toContain('Document Summary');
    expect(verification.sheetNames).toContain('Line Items');
    expect(verification.sheetNames).toContain('Reconciliation & Audit');
    expect(verification.totalRows).toBeGreaterThan(10);
    expect(verification.formulaCount).toBeGreaterThan(0);
    expect(verification.errors.length).toBe(0);
  });
});
