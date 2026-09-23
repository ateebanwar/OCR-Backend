import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CorrectionEngine } from '../../src/services/CorrectionEngine';
import { DocumentStatusCalculator } from '../../src/services/DocumentStatusCalculator';
import { ReviewResolutionService } from '../../src/services/ReviewResolutionService';
import { DocumentProcessingService } from '../../src/services/DocumentProcessingService';
import { RawFinancialExtraction } from '../../src/extraction/schemas/financialSchema';
import { CanonicalFinancialDocument } from '../../src/domain/financial';
import { ReviewIssue, CorrectionRecord } from '../../src/domain/review';
import { AIProvider } from '../../src/providers/ai/AIProvider';
import { loadConfig } from '../../src/config/env';
import { buildApp } from '../../src/app/buildApp';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { FileValidationError, UnsupportedDocumentError } from '../../src/errors/AppError';

describe('Correction & Review Workflow Engine', () => {
  // ============================================================================
  // 1. CORRECTION ENGINE
  // ============================================================================
  describe('CorrectionEngine', () => {
    const engine = new CorrectionEngine();

    it('auto-corrects promotional discount extracted as negative unitPrice with evidence and 0 variance reconciliation', () => {
      const rawData: RawFinancialExtraction = {
        documentType: 'invoice',
        invoiceNumber: 'INV-PROMO-001',
        documentNumber: null,
        invoiceDate: '2026-03-23',
        dueDate: null,
        purchaseOrderNumber: null,
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        pageCount: 1,
        vendor: { name: 'SaaS Platform Inc', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        customer: { name: 'Acme Corp', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        lineItems: [
          {
            lineNumber: 1,
            description: 'Annual Enterprise Subscription',
            sku: null,
            quantity: 1,
            unit: null,
            unitPrice: 1000.0,
            discount: null,
            taxRate: null,
            taxAmount: null,
            lineSubtotal: 1000.0,
            lineTotal: 1000.0,
          },
          {
            lineNumber: 2,
            description: 'Promotional Discount - Spring 2026 Special Offer',
            sku: null,
            quantity: 1,
            unit: null,
            unitPrice: -150.0, // AI extracted as negative unit price!
            discount: null,
            taxRate: null,
            taxAmount: null,
            lineSubtotal: -150.0,
            lineTotal: -150.0,
          },
        ],
        totals: {
          subtotal: 1000.0,
          discountTotal: null,
          taxTotal: 0,
          taxesBreakdown: null,
          shippingCharges: null,
          additionalCharges: null,
          rounding: null,
          grandTotal: 850.0,
          paidAmount: null,
          balanceDue: 850.0,
        },
        payment: null,
      };

      const result = engine.analyzeAndCorrect(rawData);

      // Verify auto-correction took place
      expect(result.autoCorrected).toBe(true);
      expect(result.corrections.length).toBe(1);
      expect(result.corrections[0]?.source).toBe('AUTOMATIC_ENGINE');
      expect(result.corrections[0]?.originalValue).toBe(-150.0);
      expect(result.corrections[0]?.finalValue).toBe(0);
      expect(result.corrections[0]?.evidence[0]).toContain('Promotional Discount');

      // Verify corrected data values
      expect(result.data.lineItems[1]?.unitPrice).toBe(0);
      expect(result.data.lineItems[1]?.discount).toBe(150.0);
      expect(result.data.totals.discountTotal).toBe(150.0);

      // Verify deterministic reconciliation achieves 0 variance
      expect(result.reconciliation.isVerified).toBe(true);
      expect(result.reconciliation.overallStatus).toBe('EXACT_MATCH');
      expect(result.reconciliation.toleranceApplied).toBe(0);
      expect(result.reconciliation.totals.grandTotalVariance).toBe(0);

      // Verify no open issues remain
      const openIssues = result.issues.filter((i) => i.status === 'OPEN');
      expect(openIssues.length).toBe(0);
    });

    it('flags ambiguous negative value WITHOUT promotional keywords as REVIEW_REQUIRED with explicit choices', () => {
      const rawData: RawFinancialExtraction = {
        documentType: 'invoice',
        invoiceNumber: 'INV-AMBIG-002',
        documentNumber: null,
        invoiceDate: '2026-03-23',
        dueDate: null,
        purchaseOrderNumber: null,
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        pageCount: 1,
        vendor: { name: 'Hardware Supplier', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        customer: { name: 'Acme Corp', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        lineItems: [
          {
            lineNumber: 1,
            description: 'Database Server Rack',
            sku: null,
            quantity: 1,
            unit: null,
            unitPrice: 2000.0,
            discount: null,
            taxRate: null,
            taxAmount: null,
            lineSubtotal: 2000.0,
            lineTotal: 2000.0,
          },
          {
            lineNumber: 2,
            description: 'Item SKU #98421-B', // No discount/credit keywords!
            sku: '98421-B',
            quantity: 1,
            unit: null,
            unitPrice: -200.0, // Ambiguous negative value!
            discount: null,
            taxRate: null,
            taxAmount: null,
            lineSubtotal: -200.0,
            lineTotal: -200.0,
          },
        ],
        totals: {
          subtotal: 2000.0,
          discountTotal: null,
          taxTotal: 0,
          taxesBreakdown: null,
          shippingCharges: null,
          additionalCharges: null,
          rounding: null,
          grandTotal: 1800.0,
          paidAmount: null,
          balanceDue: 1800.0,
        },
        payment: null,
      };

      const result = engine.analyzeAndCorrect(rawData);

      // Should NOT blindly auto-correct
      expect(result.autoCorrected).toBe(false);

      // Must generate structured review issue
      const ambiguousIssue = result.issues.find((i) => i.type === 'AMBIGUOUS_VALUE');
      expect(ambiguousIssue).toBeDefined();
      expect(ambiguousIssue?.status).toBe('OPEN');
      expect(ambiguousIssue?.resolved).toBe(false);
      expect(ambiguousIssue?.originalValue).toBe(-200.0);
      expect(ambiguousIssue?.resolutionOptions).toEqual([
        'DISCOUNT',
        'CREDIT',
        'REFUND',
        'ADJUSTMENT',
        'OTHER',
        'KEEP_AS_IS',
      ]);
    });
  });

  // ============================================================================
  // 2. DOCUMENT STATUS CALCULATOR
  // ============================================================================
  describe('DocumentStatusCalculator', () => {
    it('determines VERIFIED when everything is reconciled, verified, and no corrections were needed', () => {
      const status = DocumentStatusCalculator.calculateStatus({
        isVerified: true,
        reconciliationVerified: true,
        issues: [],
        corrections: [],
      });
      expect(status).toBe('VERIFIED');
    });

    it('determines VERIFIED_WITH_CORRECTIONS when everything is verified and corrections exist', () => {
      const status = DocumentStatusCalculator.calculateStatus({
        isVerified: true,
        reconciliationVerified: true,
        issues: [],
        corrections: [
          {
            issueId: 'corr-1',
            page: 1,
            field: 'lineItems[1].unitPrice',
            originalField: 'lineItems[1].unitPrice',
            originalValue: -150,
            finalValue: 0,
            reason: 'Auto-corrected promotional discount',
            evidence: ['Keyword promo'],
            resolved: true,
            timestamp: new Date().toISOString(),
            source: 'AUTOMATIC_ENGINE',
          },
        ],
      });
      expect(status).toBe('VERIFIED_WITH_CORRECTIONS');
    });

    it('determines REVIEW_REQUIRED when open issues exist', () => {
      const openIssue: ReviewIssue = {
        id: 'issue-1',
        type: 'AMBIGUOUS_VALUE',
        severity: 'WARNING',
        status: 'OPEN',
        page: 1,
        field: 'lineItems[0].unitPrice',
        originalValue: -50,
        aiInterpretation: { field: 'unitPrice', value: -50 },
        message: 'Ambiguous negative value',
        reason: 'Requires user confirmation',
        evidence: [],
        resolutionOptions: ['DISCOUNT', 'KEEP_AS_IS'],
        resolved: false,
      };

      const status = DocumentStatusCalculator.calculateStatus({
        isVerified: true,
        reconciliationVerified: true,
        issues: [openIssue],
        corrections: [],
      });
      expect(status).toBe('REVIEW_REQUIRED');
    });

    it('determines REVIEW_REQUIRED when mathematical reconciliation fails even if issues are marked resolved', () => {
      const status = DocumentStatusCalculator.calculateStatus({
        isVerified: false,
        reconciliationVerified: false, // Math does NOT balance!
        issues: [],
        corrections: [],
      });
      expect(status).toBe('REVIEW_REQUIRED');
    });

    it('determines REJECTED when isRejected flag is set', () => {
      const status = DocumentStatusCalculator.calculateStatus({
        isVerified: false,
        reconciliationVerified: false,
        issues: [],
        corrections: [],
        isRejected: true,
      });
      expect(status).toBe('REJECTED');
    });
  });

  // ============================================================================
  // 3. REVIEW RESOLUTION SERVICE (HMAC TOKENS & RESOLUTION LOGIC)
  // ============================================================================
  describe('ReviewResolutionService', () => {
    const service = new ReviewResolutionService('test-secret-salt-key-2026');

    const sampleCanonicalDoc: CanonicalFinancialDocument = {
      documentId: 'doc-review-123',
      sourceFilename: 'invoice_review_sample.pdf',
      documentHash: 'a1b2c3d4e5f6',
      documentType: 'invoice',
      invoiceNumber: 'INV-REV-100',
      documentNumber: null,
      invoiceDate: '2026-03-23',
      dueDate: null,
      purchaseOrderNumber: null,
      referenceNumbers: [],
      currency: 'USD',
      language: 'en',
      processingTimestamp: new Date().toISOString(),
      vendor: { name: 'Vendor Tech', address: null, taxId: null, email: null, phone: null, contactPerson: null },
      customer: { name: 'Client Corp', address: null, taxId: null, email: null, phone: null, contactPerson: null },
      lineItems: [
        {
          lineNumber: 1,
          description: 'Software License',
          sku: null,
          quantity: 1,
          unit: null,
          unitPrice: 1000.0,
          discount: null,
          taxRate: null,
          taxAmount: null,
          lineSubtotal: 1000.0,
          lineTotal: 1000.0,
        },
        {
          lineNumber: 2,
          description: 'Special Adjustment Credit',
          sku: null,
          quantity: 1,
          unit: null,
          unitPrice: -200.0,
          discount: null,
          taxRate: null,
          taxAmount: null,
          lineSubtotal: -200.0,
          lineTotal: -200.0,
        },
      ],
      totals: {
        subtotal: 1000.0,
        discountTotal: null,
        taxTotal: 0,
        taxesBreakdown: null,
        shippingCharges: null,
        additionalCharges: null,
        rounding: null,
        grandTotal: 800.0,
        paidAmount: null,
        balanceDue: 800.0,
      },
      payment: null,
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

    const sampleIssue: ReviewIssue = {
      id: 'issue-test-1',
      type: 'AMBIGUOUS_VALUE',
      severity: 'WARNING',
      status: 'OPEN',
      page: 1,
      field: 'lineItems[1].unitPrice',
      lineItemIndex: 1,
      originalValue: -200.0,
      aiInterpretation: { field: 'unitPrice', value: -200.0 },
      message: 'Ambiguous negative value',
      reason: 'Confirm classification',
      evidence: [],
      resolutionOptions: ['DISCOUNT', 'CREDIT', 'REFUND', 'ADJUSTMENT', 'OTHER', 'KEEP_AS_IS'],
      resolved: false,
    };

    it('generates a valid tamper-proof HMAC review token and verifies it successfully', () => {
      const token = service.createReviewToken({
        documentId: sampleCanonicalDoc.documentId,
        documentHash: sampleCanonicalDoc.documentHash,
        sourceFilename: sampleCanonicalDoc.sourceFilename,
        canonicalDoc: sampleCanonicalDoc,
        issues: [sampleIssue],
        corrections: [],
        auditTrail: {
          stages: [],
          totalProcessingTimeMs: 100,
          complexityLevel: 'LEVEL_1_SIMPLE',
          complexityScore: 10,
          complexitySignals: {},
          selectedModelTier: 'TIER_1_STANDARD',
          selectedModel: 'gemini-3.6-flash',
          verificationModel: 'gemini-3.7-flash',
          fallbackUsed: false,
          retryCount: 0,
          escalationCount: 0,
          correctionCount: 0,
          modelsUsed: ['gemini-3.6-flash'],
          modelInvocations: [],
          verificationGate: {
            isVerified: false,
            reconciliationVerified: false,
            secondPassVerified: true,
            completenessVerified: true,
            semanticVerified: true,
            xlsxVerified: true,
            gateFailureReasons: ['Review required'],
          },
        },
      });

      expect(typeof token).toBe('string');
      expect(token.includes('.')).toBe(true);

      const verifiedPayload = service.verifyReviewToken(token);
      expect(verifiedPayload.documentId).toBe('doc-review-123');
      expect(verifiedPayload.issues.length).toBe(1);
      expect(verifiedPayload.issues[0]?.id).toBe('issue-test-1');
    });

    it('rejects tampered or forged review tokens with signature verification failure', () => {
      const token = service.createReviewToken({
        documentId: sampleCanonicalDoc.documentId,
        documentHash: sampleCanonicalDoc.documentHash,
        sourceFilename: sampleCanonicalDoc.sourceFilename,
        canonicalDoc: sampleCanonicalDoc,
        issues: [sampleIssue],
        corrections: [],
        auditTrail: {} as any,
      });

      const parts = token.split('.');
      const tamperedToken = `${parts[0]}.invalidSignatureHmac12345`;

      expect(() => service.verifyReviewToken(tamperedToken)).toThrow(
        /signature verification failed/i
      );
    });

    it('resolves issue with DISCOUNT decision, balances math, and achieves VERIFIED_WITH_CORRECTIONS', async () => {
      const token = service.createReviewToken({
        documentId: sampleCanonicalDoc.documentId,
        documentHash: sampleCanonicalDoc.documentHash,
        sourceFilename: sampleCanonicalDoc.sourceFilename,
        canonicalDoc: JSON.parse(JSON.stringify(sampleCanonicalDoc)),
        issues: [JSON.parse(JSON.stringify(sampleIssue))],
        corrections: [],
        auditTrail: {
          stages: [],
          totalProcessingTimeMs: 150,
          complexityLevel: 'LEVEL_1_SIMPLE',
          complexityScore: 10,
          complexitySignals: {},
          selectedModelTier: 'TIER_1_STANDARD',
          selectedModel: 'gemini-3.6-flash',
          verificationModel: 'gemini-3.7-flash',
          fallbackUsed: false,
          retryCount: 0,
          escalationCount: 0,
          correctionCount: 0,
          modelsUsed: ['gemini-3.6-flash'],
          modelInvocations: [],
          verificationGate: {
            isVerified: false,
            reconciliationVerified: false,
            secondPassVerified: true,
            completenessVerified: true,
            semanticVerified: true,
            xlsxVerified: true,
            gateFailureReasons: [],
          },
        },
      });

      const resolutionResult = await service.resolveReview({
        reviewToken: token,
        resolutions: [
          {
            issueId: 'issue-test-1',
            userDecision: 'DISCOUNT',
          },
        ],
      });

      expect(resolutionResult.success).toBe(true);
      expect(resolutionResult.summary.status).toBe('VERIFIED_WITH_CORRECTIONS');
      expect(resolutionResult.reconciliation.isVerified).toBe(true);
      expect(resolutionResult.reconciliation.totals.grandTotalVariance).toBe(0);
      expect(resolutionResult.summary.review?.required).toBe(false);
      expect(resolutionResult.summary.corrections?.length).toBe(1);
      expect(resolutionResult.summary.corrections?.[0]?.source).toBe('USER');
      expect(resolutionResult.summary.corrections?.[0]?.finalValue).toBe(0);
    });

    it('preserves source value on KEEP_AS_IS without bypassing reconciliation (math remains unbalanced -> REVIEW_REQUIRED)', async () => {
      const unbalancedDoc = JSON.parse(JSON.stringify(sampleCanonicalDoc));
      // In this document, grandTotal was 999 (arithmetically contradictory to line items)
      unbalancedDoc.totals.grandTotal = 999.0;

      const token = service.createReviewToken({
        documentId: unbalancedDoc.documentId,
        documentHash: unbalancedDoc.documentHash,
        sourceFilename: unbalancedDoc.sourceFilename,
        canonicalDoc: unbalancedDoc,
        issues: [JSON.parse(JSON.stringify(sampleIssue))],
        corrections: [],
        auditTrail: {
          stages: [],
          totalProcessingTimeMs: 150,
          complexityLevel: 'LEVEL_1_SIMPLE',
          complexityScore: 10,
          complexitySignals: {},
          selectedModelTier: 'TIER_1_STANDARD',
          selectedModel: 'gemini-3.6-flash',
          verificationModel: 'gemini-3.7-flash',
          fallbackUsed: false,
          retryCount: 0,
          escalationCount: 0,
          correctionCount: 0,
          modelsUsed: ['gemini-3.6-flash'],
          modelInvocations: [],
          verificationGate: {
            isVerified: false,
            reconciliationVerified: false,
            secondPassVerified: true,
            completenessVerified: true,
            semanticVerified: true,
            xlsxVerified: true,
            gateFailureReasons: [],
          },
        },
      });

      // User selects KEEP_AS_IS
      const resolutionResult = await service.resolveReview({
        reviewToken: token,
        resolutions: [
          {
            issueId: 'issue-test-1',
            userDecision: 'KEEP_AS_IS',
          },
        ],
      });

      // CRITICAL REQUIREMENT: KEEP_AS_IS preserves source value, but NEVER bypasses mathematical reconciliation!
      expect(resolutionResult.success).toBe(true);
      expect(resolutionResult.reconciliation.isVerified).toBe(false);
      expect(resolutionResult.summary.status).toBe('REVIEW_REQUIRED');
      expect(resolutionResult.summary.review?.required).toBe(true);

      // Verify the original value was preserved exactly
      expect(resolutionResult.document.lineItems[1]?.unitPrice).toBe(-200.0);
    });

    it('records OTHER decision with customMeaning and audit trail', async () => {
      const token = service.createReviewToken({
        documentId: sampleCanonicalDoc.documentId,
        documentHash: sampleCanonicalDoc.documentHash,
        sourceFilename: sampleCanonicalDoc.sourceFilename,
        canonicalDoc: JSON.parse(JSON.stringify(sampleCanonicalDoc)),
        issues: [JSON.parse(JSON.stringify(sampleIssue))],
        corrections: [],
        auditTrail: {} as any,
      });

      const resolutionResult = await service.resolveReview({
        reviewToken: token,
        resolutions: [
          {
            issueId: 'issue-test-1',
            userDecision: 'OTHER',
            customMeaning: 'Manufacturer Loyalty Rebate',
          },
        ],
      });

      const resolvedIssue = resolutionResult.summary.issues?.find((i) => i.id === 'issue-test-1');
      expect(resolvedIssue?.resolved).toBe(true);
      expect(resolvedIssue?.userDecision).toBe('OTHER');
      expect(resolvedIssue?.customMeaning).toBe('Manufacturer Loyalty Rebate');

      const userCorrection = resolutionResult.summary.corrections?.find((c) => c.source === 'USER');
      expect(userCorrection?.reason).toContain('Manufacturer Loyalty Rebate');
    });

    it('maintains idempotency: submitting same resolution multiple times produces identical result without duplicate corrections', async () => {
      const token = service.createReviewToken({
        documentId: sampleCanonicalDoc.documentId,
        documentHash: sampleCanonicalDoc.documentHash,
        sourceFilename: sampleCanonicalDoc.sourceFilename,
        canonicalDoc: JSON.parse(JSON.stringify(sampleCanonicalDoc)),
        issues: [JSON.parse(JSON.stringify(sampleIssue))],
        corrections: [],
        auditTrail: {} as any,
      });

      const firstPass = await service.resolveReview({
        reviewToken: token,
        resolutions: [
          {
            issueId: 'issue-test-1',
            userDecision: 'DISCOUNT',
          },
        ],
      });

      const secondPass = await service.resolveReview({
        reviewToken: token,
        resolutions: [
          {
            issueId: 'issue-test-1',
            userDecision: 'DISCOUNT',
          },
        ],
      });

      expect(firstPass.summary.corrections?.length).toBe(1);
      expect(secondPass.summary.corrections?.length).toBe(1);
      expect(secondPass.summary.status).toBe(firstPass.summary.status);
    });
  });

  // ============================================================================
  // 4. FASTIFY API INTEGRATION: POST /api/v1/documents/review
  // ============================================================================
  describe('Fastify Review API Route', () => {
    it('handles review resolution request and returns updated 200 payload', async () => {
      const mockAi: AIProvider = {
        providerName: 'mock',
        analyzeDocument: vi.fn(),
        extractStructuredData: vi.fn(),
        chat: vi.fn(),
        streamChat: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', provider: 'mock' }),
      };

      const config = loadConfig({ NODE_ENV: 'test', AI_PROVIDER: 'mock' });
      const app = await buildApp({ config, aiProvider: mockAi });
      await app.ready();

      // Create a valid review token
      const reviewService = new ReviewResolutionService();
      const mockDoc: CanonicalFinancialDocument = {
        documentId: 'doc-api-test',
        sourceFilename: 'api_test.pdf',
        documentHash: 'hash123',
        documentType: 'invoice',
        invoiceNumber: 'INV-API-1',
        documentNumber: null,
        invoiceDate: '2026-03-23',
        dueDate: null,
        purchaseOrderNumber: null,
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        processingTimestamp: new Date().toISOString(),
        vendor: { name: 'Acme Services Inc', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        customer: { name: 'Client Corp', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        lineItems: [
          {
            lineNumber: 1,
            description: 'Item 1',
            sku: null,
            quantity: 1,
            unit: null,
            unitPrice: 100,
            discount: null,
            taxRate: null,
            taxAmount: null,
            lineSubtotal: 100,
            lineTotal: 100,
          },
          {
            lineNumber: 2,
            description: 'Ambiguous discount',
            sku: null,
            quantity: 1,
            unit: null,
            unitPrice: -20,
            discount: null,
            taxRate: null,
            taxAmount: null,
            lineSubtotal: -20,
            lineTotal: -20,
          },
        ],
        totals: {
          subtotal: 100,
          discountTotal: null,
          taxTotal: 0,
          taxesBreakdown: null,
          shippingCharges: null,
          additionalCharges: null,
          rounding: null,
          grandTotal: 80,
          paidAmount: null,
          balanceDue: 80,
        },
        payment: null,
        coverage: {
          totalPages: 1,
          processedPages: 1,
          extractedPages: [1],
          failedPages: [],
          skippedPages: [],
          extractionCompleteness: 1,
          isFullyCovered: true,
        },
      };

      const token = reviewService.createReviewToken({
        documentId: mockDoc.documentId,
        documentHash: mockDoc.documentHash,
        sourceFilename: mockDoc.sourceFilename,
        canonicalDoc: mockDoc,
        issues: [
          {
            id: 'issue-api-1',
            type: 'AMBIGUOUS_VALUE',
            severity: 'WARNING',
            status: 'OPEN',
            page: 1,
            field: 'lineItems[1].unitPrice',
            lineItemIndex: 1,
            originalValue: -20,
            aiInterpretation: { field: 'unitPrice', value: -20 },
            message: 'Ambiguous negative value',
            reason: 'User confirmation required',
            evidence: [],
            resolutionOptions: ['DISCOUNT', 'CREDIT', 'KEEP_AS_IS'],
            resolved: false,
          },
        ],
        corrections: [],
        auditTrail: {
          stages: [],
          totalProcessingTimeMs: 100,
          complexityLevel: 'LEVEL_1_SIMPLE',
          complexityScore: 10,
          complexitySignals: {},
          selectedModelTier: 'TIER_1_STANDARD',
          selectedModel: 'gemini-3.6-flash',
          verificationModel: 'gemini-3.7-flash',
          fallbackUsed: false,
          retryCount: 0,
          escalationCount: 0,
          correctionCount: 0,
          modelsUsed: ['gemini-3.6-flash'],
          modelInvocations: [],
          verificationGate: {
            isVerified: false,
            reconciliationVerified: false,
            secondPassVerified: true,
            completenessVerified: true,
            semanticVerified: true,
            xlsxVerified: true,
            gateFailureReasons: [],
          },
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/review',
        headers: { 'content-type': 'application/json' },
        payload: {
          reviewToken: token,
          resolutions: [
            {
              issueId: 'issue-api-1',
              userDecision: 'DISCOUNT',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.success).toBe(true);
      expect(json.data.summary.status).toBe('VERIFIED_WITH_CORRECTIONS');
      expect(json.data.summary.review.required).toBe(false);
      expect(json.data.isVerified).toBe(true);

      await app.close();
    });

    it('rejects invalid review request with 422 VALIDATION_FAILED when reviewToken is missing or resolutions empty', async () => {
      const mockAi: AIProvider = {
        providerName: 'mock',
        analyzeDocument: vi.fn(),
        extractStructuredData: vi.fn(),
        chat: vi.fn(),
        streamChat: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', provider: 'mock' }),
      };

      const config = loadConfig({ NODE_ENV: 'test', AI_PROVIDER: 'mock' });
      const app = await buildApp({ config, aiProvider: mockAi });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/review',
        headers: { 'content-type': 'application/json' },
        payload: {
          reviewToken: '',
          resolutions: [],
        },
      });

      expect(response.statusCode).toBe(422);
      const json = JSON.parse(response.body);
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('VALIDATION_FAILED');

      await app.close();
    });
  });

  // ============================================================================
  // 5. END-TO-END PIPELINE STATUS SEMANTICS (A - F & REGRESSION AUDIT)
  // ============================================================================
  describe('End-to-End Pipeline Status Semantics & Regression', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      PORT: '3002',
    });

    const validSamplePdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
    );

    it('A. Clean invoice -> produces VERIFIED status with verified reconciliation and no review required', async () => {
      const mockAi = new MockAIProvider();
      const processingService = new DocumentProcessingService(mockAi, config);

      const result = await processingService.processDocument(validSamplePdf, 'clean-invoice.pdf');

      expect(result.success).toBe(true);
      expect(result.isVerified).toBe(true);
      expect(result.reconciliation.isVerified).toBe(true);
      expect(result.reconciliation.overallStatus).toBe('EXACT_MATCH');
      expect(result.summary.status).toBe('VERIFIED');
      expect(result.summary.review?.required).toBe(false);
      expect(result.summary.review?.reviewToken).toBeUndefined();
      expect(result.xlsxBase64).toBeDefined();
      expect(result.xlsxVerification.isValid).toBe(true);
    });

    it('B. Auto-corrected promotional discount -> produces VERIFIED_WITH_CORRECTIONS status with 0 variance math', async () => {
      const mockAi = new MockAIProvider();
      mockAi.customExtractHandler = (_doc, _prompt, options) => {
        if (options?.purpose === 'VERIFICATION') {
          return {
            isVerified: true,
            confidenceScore: 1.0,
            issuesFound: [],
            correctionsNeeded: [],
            verifierNotes: 'Verified',
          };
        }
        return {
          documentType: 'invoice',
          invoiceNumber: 'INV-PROMO-99',
          documentNumber: null,
          invoiceDate: '2026-03-23',
          dueDate: null,
          purchaseOrderNumber: null,
          referenceNumbers: [],
          currency: 'USD',
          language: 'en',
          pageCount: 1,
          vendor: { name: 'SaaS Platform Inc', address: null, taxId: null, email: null, phone: null, contactPerson: null },
          customer: { name: 'Acme Corp', address: null, taxId: null, email: null, phone: null, contactPerson: null },
          lineItems: [
            {
              lineNumber: 1,
              description: 'Annual Enterprise Subscription',
              sku: null,
              quantity: 1,
              unit: null,
              unitPrice: 1000.0,
              discount: null,
              taxRate: null,
              taxAmount: null,
              lineSubtotal: 1000.0,
              lineTotal: 1000.0,
            },
            {
              lineNumber: 2,
              description: 'Promotional Discount - Spring 2026 Special Offer',
              sku: null,
              quantity: 1,
              unit: null,
              unitPrice: -150.0,
              discount: null,
              taxRate: null,
              taxAmount: null,
              lineSubtotal: -150.0,
              lineTotal: -150.0,
            },
          ],
          totals: {
            subtotal: 1000.0,
            discountTotal: null,
            taxTotal: 0,
            taxesBreakdown: null,
            shippingCharges: null,
            additionalCharges: null,
            rounding: null,
            grandTotal: 850.0,
            paidAmount: null,
            balanceDue: 850.0,
          },
          payment: null,
        };
      };

      const processingService = new DocumentProcessingService(mockAi, config);
      const result = await processingService.processDocument(validSamplePdf, 'promo-invoice.pdf');

      expect(result.success).toBe(true);
      expect(result.isVerified).toBe(true);
      expect(result.reconciliation.isVerified).toBe(true);
      expect(result.summary.status).toBe('VERIFIED_WITH_CORRECTIONS');
      expect(result.summary.corrections?.length).toBe(1);
      expect(result.summary.corrections?.[0]?.source).toBe('AUTOMATIC_ENGINE');
      expect(result.summary.review?.required).toBe(false);
      expect(result.xlsxBase64).toBeDefined();
    });

    it('C. Ambiguous value -> produces REVIEW_REQUIRED + XLSX + reviewToken without throwing', async () => {
      const mockAi = new MockAIProvider();
      mockAi.customExtractHandler = () => {
        return {
          documentType: 'invoice',
          invoiceNumber: 'INV-AMBIG-77',
          documentNumber: null,
          invoiceDate: '2026-03-23',
          dueDate: null,
          purchaseOrderNumber: null,
          referenceNumbers: [],
          currency: 'USD',
          language: 'en',
          pageCount: 1,
          vendor: { name: 'Hardware Supplier', address: null, taxId: null, email: null, phone: null, contactPerson: null },
          customer: { name: 'Acme Corp', address: null, taxId: null, email: null, phone: null, contactPerson: null },
          lineItems: [
            {
              lineNumber: 1,
              description: 'Database Server Rack',
              sku: null,
              quantity: 1,
              unit: null,
              unitPrice: 2000.0,
              discount: null,
              taxRate: null,
              taxAmount: null,
              lineSubtotal: 2000.0,
              lineTotal: 2000.0,
            },
            {
              lineNumber: 2,
              description: 'Item SKU #98421-B',
              sku: '98421-B',
              quantity: 1,
              unit: null,
              unitPrice: -200.0, // Ambiguous negative value!
              discount: null,
              taxRate: null,
              taxAmount: null,
              lineSubtotal: -200.0,
              lineTotal: -200.0,
            },
          ],
          totals: {
            subtotal: 2000.0,
            discountTotal: null,
            taxTotal: 0,
            taxesBreakdown: null,
            shippingCharges: null,
            additionalCharges: null,
            rounding: null,
            grandTotal: 1800.0,
            paidAmount: null,
            balanceDue: 1800.0,
          },
          payment: null,
        };
      };

      const processingService = new DocumentProcessingService(mockAi, config);
      const result = await processingService.processDocument(validSamplePdf, 'ambiguous-invoice.pdf');

      expect(result.success).toBe(true);
      expect(result.isVerified).toBe(false);
      expect(result.summary.status).toBe('REVIEW_REQUIRED');
      expect(result.summary.review?.required).toBe(true);
      expect(result.summary.review?.reviewToken).toBeDefined();
      expect(result.summary.issues?.some((i) => i.type === 'AMBIGUOUS_VALUE')).toBe(true);
      expect(result.xlsxBase64).toBeDefined();
      expect(result.xlsxVerification.isValid).toBe(true);
    });

    it('D. Unresolved RECONCILIATION_WARNING -> produces REVIEW_REQUIRED + XLSX + reviewToken without throwing DocumentProcessingError', async () => {
      const mockAi = new MockAIProvider();
      mockAi.customExtractHandler = () => {
        const flawedData = JSON.parse(JSON.stringify(mockAi.mockExtractionData));
        // Extracted grandTotal (99999.0) arithmetically contradicts line items ($3300)
        flawedData.totals.grandTotal = 99999.0;
        return flawedData;
      };

      const processingService = new DocumentProcessingService(mockAi, config);

      // Must NOT throw DocumentProcessingError!
      const result = await processingService.processDocument(validSamplePdf, 'discrepant-invoice.pdf');

      expect(result.success).toBe(true);
      expect(result.isVerified).toBe(false);
      expect(result.reconciliation.isVerified).toBe(false);
      expect(result.summary.status).toBe('REVIEW_REQUIRED');
      expect(result.summary.review?.required).toBe(true);
      expect(result.summary.review?.reviewToken).toBeDefined();
      expect(result.summary.issues?.some((i) => i.type === 'RECONCILIATION_WARNING')).toBe(true);
      expect(result.xlsxBase64).toBeDefined();
      expect(result.xlsxVerification.isValid).toBe(true);
    });

    it('E. Corrupt/unsafe PDF -> fails with FileValidationError / UnsupportedDocumentError and rejects processing', async () => {
      const mockAi = new MockAIProvider();
      const processingService = new DocumentProcessingService(mockAi, config);

      const corruptBuffer = Buffer.from('NOT_A_VALID_PDF_HEADER_CORRUPT_BYTES');

      await expect(
        processingService.processDocument(corruptBuffer, 'corrupt.pdf')
      ).rejects.toThrow(UnsupportedDocumentError);

      // DocumentStatusCalculator returns REJECTED when isRejected flag is explicitly set
      const status = DocumentStatusCalculator.calculateStatus({
        isVerified: false,
        reconciliationVerified: false,
        issues: [],
        corrections: [],
        isRejected: true,
      });
      expect(status).toBe('REJECTED');
    });

    it('F. KEEP_AS_IS must not bypass deterministic reconciliation', async () => {
      const reviewService = new ReviewResolutionService();
      const mockDoc: CanonicalFinancialDocument = {
        documentId: 'doc-recon-bypass-test',
        sourceFilename: 'unbalanced.pdf',
        documentHash: 'hash-bypass-123',
        documentType: 'invoice',
        invoiceNumber: 'INV-BYPASS-01',
        documentNumber: null,
        invoiceDate: '2026-03-23',
        dueDate: null,
        purchaseOrderNumber: null,
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        processingTimestamp: new Date().toISOString(),
        vendor: { name: 'Vendor Inc', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        customer: { name: 'Customer Corp', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        lineItems: [
          {
            lineNumber: 1,
            description: 'Item A',
            sku: null,
            quantity: 1,
            unit: null,
            unitPrice: 100.0,
            discount: null,
            taxRate: null,
            taxAmount: null,
            lineSubtotal: 100.0,
            lineTotal: 100.0,
          },
        ],
        totals: {
          subtotal: 100.0,
          discountTotal: null,
          taxTotal: 0,
          taxesBreakdown: null,
          shippingCharges: null,
          additionalCharges: null,
          rounding: null,
          grandTotal: 500.0, // Arithmetically contradictory (100 != 500)
          paidAmount: null,
          balanceDue: 500.0,
        },
        payment: null,
        coverage: {
          totalPages: 1,
          processedPages: 1,
          extractedPages: [1],
          failedPages: [],
          skippedPages: [],
          extractionCompleteness: 1,
          isFullyCovered: true,
        },
      };

      const token = reviewService.createReviewToken({
        documentId: mockDoc.documentId,
        documentHash: mockDoc.documentHash,
        sourceFilename: mockDoc.sourceFilename,
        canonicalDoc: mockDoc,
        issues: [
          {
            id: 'issue-discrepancy-1',
            type: 'RECONCILIATION_WARNING',
            severity: 'ERROR',
            status: 'OPEN',
            page: 1,
            field: 'totals',
            originalValue: 500.0,
            aiInterpretation: { field: 'totals', value: 500.0 },
            message: 'Grand total discrepancy',
            reason: 'Arithmetic variance',
            evidence: [],
            resolutionOptions: ['KEEP_AS_IS', 'OTHER'],
            resolved: false,
          },
        ],
        corrections: [],
        auditTrail: {} as any,
      });

      const resolutionResult = await reviewService.resolveReview({
        reviewToken: token,
        resolutions: [
          {
            issueId: 'issue-discrepancy-1',
            userDecision: 'KEEP_AS_IS',
          },
        ],
      });

      // Verification MUST remain false and status must remain REVIEW_REQUIRED
      expect(resolutionResult.reconciliation.isVerified).toBe(false);
      expect(resolutionResult.reconciliation.overallStatus).toBe('DISCREPANCY');
      expect(resolutionResult.reconciliation.toleranceApplied).toBe(0);
      expect(resolutionResult.summary.status).toBe('REVIEW_REQUIRED');
      expect(resolutionResult.isVerified).toBe(false);
    });

    it('11. Regression Test: Downloadable-PDF-Invoices-Add-On-Samples.pdf produces REVIEW_REQUIRED with auto-corrected promo and balance due discrepancy', async () => {
      const fixturePath = path.resolve('tests/fixtures/documents/Downloadable-PDF-Invoices-Add-On-Samples.pdf');
      expect(fs.existsSync(fixturePath)).toBe(true);
      const pdfBuffer = fs.readFileSync(fixturePath);

      const mockAi = new MockAIProvider();
      // Configure extraction simulating exact behavior of the sample document:
      // Promotional discount -$12.50 extracted on line 2, subtotal/grandTotal $37.50, paidAmount $37.50, extracted balanceDue $37.50
      mockAi.customExtractHandler = () => {
        return {
          documentType: 'invoice',
          invoiceNumber: 'INV-ADDON-001',
          documentNumber: null,
          invoiceDate: '2026-03-23',
          dueDate: null,
          purchaseOrderNumber: null,
          referenceNumbers: [],
          currency: 'USD',
          language: 'en',
          pageCount: 1,
          vendor: { name: 'Add-On Services LLC', address: null, taxId: null, email: null, phone: null, contactPerson: null },
          customer: { name: 'Client Account', address: null, taxId: null, email: null, phone: null, contactPerson: null },
          lineItems: [
            {
              lineNumber: 1,
              description: 'WordPress Hosting - Premium Add-On',
              sku: 'HOST-WP-01',
              quantity: 1,
              unit: null,
              unitPrice: 50.0,
              discount: null,
              taxRate: null,
              taxAmount: null,
              lineSubtotal: 50.0,
              lineTotal: 50.0,
            },
            {
              lineNumber: 2,
              description: 'Promotional Discount - Spring Special',
              sku: null,
              quantity: 1,
              unit: null,
              unitPrice: -12.5, // AI extracted as negative unit price!
              discount: null,
              taxRate: null,
              taxAmount: null,
              lineSubtotal: -12.5,
              lineTotal: -12.5,
            },
          ],
          totals: {
            subtotal: 50.0,
            discountTotal: null,
            taxTotal: 0,
            taxesBreakdown: null,
            shippingCharges: null,
            additionalCharges: null,
            rounding: null,
            grandTotal: 37.5,
            paidAmount: 37.5,
            balanceDue: 37.5, // Extracted as $37.50, but expected 37.50 - 37.50 = 0.00
          },
          payment: null,
        };
      };

      const processingService = new DocumentProcessingService(mockAi, config);

      // 1. Direct Service Call
      const result = await processingService.processDocument(
        pdfBuffer,
        'Downloadable-PDF-Invoices-Add-On-Samples.pdf'
      );

      // A. Promotional -$12.50 must remain correctly interpreted as a discount
      expect(result.summary.corrections?.length).toBe(1);
      expect(result.summary.corrections?.[0]?.source).toBe('AUTOMATIC_ENGINE');
      expect(result.summary.corrections?.[0]?.reason).toContain('promotional');
      expect(result.document.lineItems[1]?.unitPrice).toBe(0);
      expect(result.document.lineItems[1]?.discount).toBe(12.5);
      expect(result.document.totals.discountTotal).toBe(12.5);

      // B. Subtotal/grand total should remain $37.50
      expect(result.document.totals.grandTotal).toBe(37.5);
      expect(result.summary.financial.grandTotal).toBe(37.5);

      // C. Extracted balanceDue $37.50 vs expected $0.00 must remain an unresolved discrepancy
      expect(result.reconciliation.isVerified).toBe(false);
      expect(result.reconciliation.overallStatus).toBe('DISCREPANCY');
      const balanceDueDiscrepancy = result.reconciliation.discrepancies.find((d) =>
        d.includes('Balance due discrepancy')
      );
      expect(balanceDueDiscrepancy).toBeDefined();
      expect(balanceDueDiscrepancy).toContain('Expected 0.00');
      expect(balanceDueDiscrepancy).toContain('37.50');

      // D. The backend must NOT return DOCUMENT_PROCESSING_FAILED; it must return REVIEW_REQUIRED
      expect(result.success).toBe(true);
      expect(result.summary.status).toBe('REVIEW_REQUIRED');

      // E. XLSX must be generated if technically safe
      expect(result.xlsxBase64).toBeDefined();
      expect(result.xlsxVerification.isValid).toBe(true);

      // F. reviewToken must be generated
      expect(result.summary.review?.required).toBe(true);
      expect(typeof result.summary.review?.reviewToken).toBe('string');
      expect(result.summary.review?.reviewToken?.length).toBeGreaterThan(20);

      // G. reconciliation.isVerified must remain false
      expect(result.isVerified).toBe(false);
      expect(result.reconciliation.isVerified).toBe(false);

      // H. The issue must be visible to the frontend
      const reconIssue = result.summary.issues?.find(
        (i) => i.type === 'RECONCILIATION_WARNING'
      );
      expect(reconIssue).toBeDefined();
      expect(reconIssue?.status).toBe('OPEN');
      expect(reconIssue?.message).toContain('Balance due discrepancy');

      // I. No VERIFIED badge/status may be returned
      expect(result.summary.status).not.toBe('VERIFIED');
      expect(result.summary.status).not.toBe('VERIFIED_WITH_CORRECTIONS');

      // 2. HTTP POST /api/v1/documents/process flow
      const app = await buildApp({ config, aiProvider: mockAi });
      await app.ready();

      const boundary = '----AddOnSampleBoundary987';
      const multipartBody = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Downloadable-PDF-Invoices-Add-On-Samples.pdf"\r\nContent-Type: application/pdf\r\n\r\n`
        ),
        pdfBuffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody,
      });

      expect(response.statusCode).toBe(200);
      const apiBody = JSON.parse(response.body);
      expect(apiBody.success).toBe(true);
      expect(apiBody.data.summary.status).toBe('REVIEW_REQUIRED');
      expect(apiBody.data.isVerified).toBe(false);
      expect(apiBody.data.reconciliation.isVerified).toBe(false);
      expect(apiBody.data.summary.review.required).toBe(true);
      expect(apiBody.data.summary.review.reviewToken).toBeDefined();
      expect(apiBody.data.xlsxBase64).toBeDefined();

      await app.close();
    });
  });
});

