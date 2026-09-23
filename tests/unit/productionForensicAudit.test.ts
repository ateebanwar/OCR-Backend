import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/config/env';
import { DocumentProcessingService } from '../../src/services/DocumentProcessingService';
import { ExtractionService } from '../../src/services/ExtractionService';
import { VerificationService } from '../../src/services/VerificationService';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { validateCompleteness } from '../../src/validation/completenessValidator';
import { evaluateFinalVerificationGate } from '../../src/validation/verificationGate';
import { ModelInvocationTracker } from '../../src/domain/telemetry';
import { RawFinancialExtraction } from '../../src/extraction/schemas/financialSchema';
import { DocumentCoverageMetadata } from '../../src/domain/financial';
import { FinancialReconciliationReport } from '../../src/domain/processing';
import { XlsxVerificationReport } from '../../src/spreadsheet/xlsxVerifier';

const FIXTURES_DIR = path.resolve('tests/fixtures/documents');

describe('Production Forensic Audit & Telemetry Truthfulness Regression Suite', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    AI_PROVIDER: 'mock',
    GEMINI_API_KEY: 'test-key',
    GEMINI_EXTRACTION_MODEL: 'gemini-3.5-flash-lite',
    GEMINI_COMPLEX_EXTRACTION_MODEL: 'gemini-3.7-flash',
    GEMINI_ESCALATION_MODEL: 'gemini-3.8-flash',
    GEMINI_VERIFICATION_MODEL: 'gemini-3.7-flash',
    GEMINI_CHAT_MODEL: 'gemini-3.5-flash-lite',
  });

  // --------------------------------------------------------------------------
  // REGRESSION 1: HIGH COMPLEXITY DOCUMENT (test07_high_complexity.pdf)
  // Proves top-level isVerified === true and escalationCount === 0 for initial Tier 3
  // --------------------------------------------------------------------------
  describe('Regression Finding 1: High Complexity Statement Verification & Telemetry', () => {
    it('verifies that billing statements without invoiceDate pass completeness check without false negatives', () => {
      const statementData: RawFinancialExtraction = {
        documentType: 'statement',
        invoiceNumber: null,
        documentNumber: 'CON-77001',
        invoiceDate: null, // Statements legitimately omit invoiceDate
        dueDate: null,
        purchaseOrderNumber: null,
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        pageCount: 3,
        vendor: {
          name: 'INTERNATIONAL INFRASTRUCTURE HOLDINGS GMBH',
          address: null,
          taxId: null,
          email: null,
          phone: null,
          contactPerson: null,
        },
        customer: null,
        lineItems: [
          { lineNumber: 1, description: 'Blade Cluster', sku: null, quantity: 4, unit: null, unitPrice: 2500, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 10000, lineTotal: 10000 },
          { lineNumber: 2, description: 'Fiber Line', sku: null, quantity: 2, unit: null, unitPrice: 1500, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 3000, lineTotal: 3000 },
          { lineNumber: 3, description: 'SOC Security', sku: null, quantity: 1, unit: null, unitPrice: 5000, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 5000, lineTotal: 5000 },
          { lineNumber: 4, description: 'Disaster Recovery', sku: null, quantity: 1, unit: null, unitPrice: 2000, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 2000, lineTotal: 2000 },
          { lineNumber: 5, description: 'Compliance Cert', sku: null, quantity: 1, unit: null, unitPrice: 3000, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 3000, lineTotal: 3000 },
        ],
        totals: {
          subtotal: 23000,
          discountTotal: null,
          taxTotal: 4370,
          taxesBreakdown: [{ name: 'VAT', rate: 19, amount: 4370 }],
          shippingCharges: null,
          additionalCharges: null,
          rounding: null,
          grandTotal: 27370,
          paidAmount: null,
          balanceDue: null,
        },
        payment: null,
      };

      const coverage: DocumentCoverageMetadata = {
        totalPages: 3,
        processedPages: 3,
        extractedPages: [1, 2, 3],
        failedPages: [],
        skippedPages: [],
        extractionCompleteness: 1.0,
        isFullyCovered: true,
      };

      const result = validateCompleteness(statementData, coverage);
      expect(result.isComplete).toBe(true);
      expect(result.missingCrucialFields).toEqual([]);
      expect(result.notes.some((n) => n.includes('does not specify a document-level date'))).toBe(true);
    });

    it('processes test07_high_complexity.pdf end-to-end: achieves top-level isVerified=true and escalationCount=0', async () => {
      const pdfBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'test07_high_complexity.pdf'));
      const mockProvider = new MockAIProvider();

      mockProvider.mockExtractionData = {
        documentType: 'statement',
        invoiceNumber: null,
        documentNumber: 'CON-77001',
        invoiceDate: null,
        dueDate: null,
        purchaseOrderNumber: null,
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        pageCount: 3,
        vendor: {
          name: 'INTERNATIONAL INFRASTRUCTURE HOLDINGS GMBH',
          address: null,
          taxId: null,
          email: null,
          phone: null,
          contactPerson: null,
        },
        customer: null,
        lineItems: [
          { lineNumber: 1, description: 'Blade Cluster', sku: null, quantity: 4, unit: null, unitPrice: 2500, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 10000, lineTotal: 10000 },
          { lineNumber: 2, description: 'Fiber Line', sku: null, quantity: 2, unit: null, unitPrice: 1500, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 3000, lineTotal: 3000 },
          { lineNumber: 3, description: 'SOC Security', sku: null, quantity: 1, unit: null, unitPrice: 5000, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 5000, lineTotal: 5000 },
          { lineNumber: 4, description: 'Disaster Recovery', sku: null, quantity: 1, unit: null, unitPrice: 2000, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 2000, lineTotal: 2000 },
          { lineNumber: 5, description: 'Compliance Cert', sku: null, quantity: 1, unit: null, unitPrice: 3000, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 3000, lineTotal: 3000 },
        ],
        totals: {
          subtotal: 23000,
          discountTotal: null,
          taxTotal: 4370,
          taxesBreakdown: [{ name: 'VAT', rate: 19, amount: 4370 }],
          shippingCharges: null,
          additionalCharges: null,
          rounding: null,
          grandTotal: 27370,
          paidAmount: null,
          balanceDue: null,
        },
        payment: null,
      };

      const service = new DocumentProcessingService(mockProvider, config);
      const result = await service.processDocument(pdfBuffer, 'test07_high_complexity.pdf');

      expect(result.success).toBe(true);
      expect(result.auditTrail.complexityLevel).toBe('LEVEL_3_AMBIGUOUS');
      expect(result.auditTrail.selectedModelTier).toBe('TIER_3_ESCALATION');
      expect(result.auditTrail.selectedModel).toBe('gemini-3.8-flash');
      // Crucial: Initial Tier 3 routing is NOT an escalation event!
      expect(result.auditTrail.escalationCount).toBe(0);
      expect(result.auditTrail.retryCount).toBe(0);
      expect(result.auditTrail.fallbackUsed).toBe(false);
      expect(result.reconciliation.overallStatus).toBe('EXACT_MATCH');
      expect(result.reconciliation.isVerified).toBe(true);
      expect(result.xlsxVerification.isValid).toBe(true);
      // Top-level isVerified MUST be true
      expect(result.isVerified).toBe(true);
      expect(result.auditTrail.verificationGate?.isVerified).toBe(true);
      expect(result.auditTrail.verificationGate?.gateFailureReasons).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // REGRESSION 2: COMPLEX DOCUMENT TELEMETRY (test08_onepage_complex.pdf)
  // Proves escalationCount === 0 when starting on Tier 2 without runtime escalation
  // --------------------------------------------------------------------------
  describe('Regression Finding 2: Complex Document Tier 2 Routing Telemetry Truthfulness', () => {
    it('verifies test08_onepage_complex.pdf reports escalationCount=0 when initial Tier 2 extraction succeeds', async () => {
      const pdfBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'test08_onepage_complex.pdf'));
      const mockProvider = new MockAIProvider();

      mockProvider.mockExtractionData = {
        documentType: 'invoice',
        invoiceNumber: 'INV-00808',
        documentNumber: null,
        invoiceDate: '2026-03-18',
        dueDate: '2026-04-18',
        purchaseOrderNumber: null,
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        pageCount: 1,
        vendor: {
          name: 'APEX INDUSTRIAL DYNAMICS',
          address: null,
          taxId: null,
          email: null,
          phone: null,
          contactPerson: null,
        },
        customer: {
          name: 'GLOBAL CORP',
          address: null,
          taxId: null,
          email: null,
          phone: null,
          contactPerson: null,
        },
        lineItems: [
          { lineNumber: 1, description: 'Heavy Actuator Assembly', sku: null, quantity: 2, unit: null, unitPrice: 500, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 1000, lineTotal: 1000 },
          { lineNumber: 2, description: 'Precision Valve Coupler', sku: null, quantity: 5, unit: null, unitPrice: 150, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 750, lineTotal: 750 },
          { lineNumber: 3, description: 'Calibration Inspection', sku: null, quantity: 1, unit: null, unitPrice: 200, discount: null, taxRate: null, taxAmount: null, lineSubtotal: 200, lineTotal: 200 },
        ],
        totals: {
          subtotal: 1950,
          discountTotal: null,
          taxTotal: 195,
          taxesBreakdown: [{ name: 'Tax', rate: 10, amount: 195 }],
          shippingCharges: null,
          additionalCharges: null,
          rounding: null,
          grandTotal: 2145,
          paidAmount: null,
          balanceDue: null,
        },
        payment: null,
      };

      const service = new DocumentProcessingService(mockProvider, config);
      const result = await service.processDocument(pdfBuffer, 'test08_onepage_complex.pdf');

      expect(result.success).toBe(true);
      expect(result.auditTrail.complexityLevel).toBe('LEVEL_2_COMPLEX');
      expect(result.auditTrail.selectedModelTier).toBe('TIER_2_COMPLEX');
      expect(result.auditTrail.selectedModel).toBe('gemini-3.7-flash');
      // Crucial: No model transition occurred -> escalationCount MUST be 0!
      expect(result.auditTrail.escalationCount).toBe(0);
      expect(result.auditTrail.retryCount).toBe(0);
      expect(result.auditTrail.fallbackUsed).toBe(false);
      expect(result.isVerified).toBe(true);
      // modelsUsed must contain the models actually invoked
      expect(result.auditTrail.modelsUsed).toContain('gemini-3.7-flash');
    });
  });

  // --------------------------------------------------------------------------
  // REGRESSION 3: TRUE RUNTIME ESCALATION (Tier 2 -> Tier 3)
  // --------------------------------------------------------------------------
  describe('Regression Finding 3: Genuine Runtime Escalation Semantics', () => {
    it('records escalationCount=1 and multiple modelsUsed when Tier 2 fails and escalates to Tier 3', async () => {
      const mockProvider = new MockAIProvider();
      let callCount = 0;

      mockProvider.customExtractHandler = async (_doc, _prompt, options) => {
        callCount++;
        if (callCount === 1) {
          // First attempt at Tier 2 fails with non-JSON syntax error
          expect(options?.model).toBe('gemini-3.7-flash');
          throw new Error('CORRUPTED_RESPONSE_UNPARSEABLE');
        }
        // Second attempt at Tier 3 succeeds
        expect(options?.model).toBe('gemini-3.8-flash');
        return mockProvider.mockExtractionData;
      };

      const extractionService = new ExtractionService(mockProvider, config);
      const tracker = new ModelInvocationTracker();
      const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj\nendobj\n%%EOF');

      const result = await extractionService.extractFinancialDocument(fakePdf, 'invoice.pdf', 'LEVEL_2_COMPLEX', tracker);

      expect(callCount).toBe(2);
      expect(result.escalationCount).toBe(1);
      expect(result.retriesAttempted).toBe(1);
      expect(result.modelsUsed).toContain('gemini-3.7-flash');
      expect(result.modelsUsed).toContain('gemini-3.8-flash');
    });
  });

  // --------------------------------------------------------------------------
  // REGRESSION 4: RETRY WITHOUT ESCALATION
  // --------------------------------------------------------------------------
  describe('Regression Finding 4: Retry vs Escalation Distinction', () => {
    it('distinguishes retry (same model tier) from escalation (model tier transition)', () => {
      const tracker = new ModelInvocationTracker();

      // Invocations: Primary fails -> Retry on same model succeeds
      tracker.record({
        provider: 'gemini',
        model: 'gemini-3.7-flash',
        purpose: 'EXTRACTION',
        attempt: 1,
        durationMs: 500,
        timestamp: new Date().toISOString(),
        outcome: 'FAILURE',
        error: '503 Service Unavailable',
      });

      tracker.record({
        provider: 'gemini',
        model: 'gemini-3.7-flash',
        purpose: 'RETRY',
        attempt: 2,
        durationMs: 450,
        timestamp: new Date().toISOString(),
        outcome: 'SUCCESS',
      });

      expect(tracker.getRetryCount()).toBe(1);
      expect(tracker.getEscalationCount()).toBe(0);
      expect(tracker.getFallbackInfo().fallbackUsed).toBe(false);
      expect(tracker.getUniqueModels()).toEqual(['gemini-3.7-flash']);
    });
  });

  // --------------------------------------------------------------------------
  // REGRESSION 5: FALLBACK VS ESCALATION
  // --------------------------------------------------------------------------
  describe('Regression Finding 5: Candidate Fallback Telemetry Truthfulness', () => {
    it('identifies provider-level fallback without misreporting it as escalation', () => {
      const tracker = new ModelInvocationTracker();

      // Primary candidate fails with 503
      tracker.record({
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        purpose: 'EXTRACTION',
        attempt: 1,
        durationMs: 300,
        timestamp: new Date().toISOString(),
        outcome: 'FALLBACK',
        trigger: 'TRANSIENT_503_OR_429',
      });

      // Secondary candidate succeeds
      tracker.record({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        purpose: 'FALLBACK',
        attempt: 2,
        durationMs: 600,
        timestamp: new Date().toISOString(),
        outcome: 'SUCCESS',
      });

      const summary = tracker.getSummary();
      expect(summary.fallbackUsed).toBe(true);
      expect(summary.fallbackModel).toBe('gemini-3.6-flash');
      expect(summary.escalationCount).toBe(0);
    });

    it('does NOT report fallbackUsed=true when primary model is gemini-3.5-flash-lite and succeeds', () => {
      const tracker = new ModelInvocationTracker();

      // Primary Tier 1 model succeeds on attempt 1
      tracker.record({
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        purpose: 'EXTRACTION',
        attempt: 1,
        durationMs: 250,
        timestamp: new Date().toISOString(),
        outcome: 'SUCCESS',
      });

      const summary = tracker.getSummary();
      expect(summary.fallbackUsed).toBe(false);
      expect(summary.fallbackModel).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // REGRESSION 6: DETERMINISTIC RECONCILIATION AUTHORITATIVENESS
  // --------------------------------------------------------------------------
  describe('Regression Finding 6: Final Verification Gate Multi-Pillar Aggregation', () => {
    const validReconciliation: FinancialReconciliationReport = {
      documentId: 'doc-123',
      reconciledAt: new Date().toISOString(),
      overallStatus: 'EXACT_MATCH',
      isVerified: true,
      toleranceApplied: 0,
      currency: 'USD',
      currencyPrecision: 2,
      lineItems: [],
      totals: {
        calculatedSubtotal: 100,
        extractedSubtotal: 100,
        subtotalVariance: 0,
        calculatedTaxTotal: 10,
        extractedTaxTotal: 10,
        taxVariance: 0,
        calculatedGrandTotal: 110,
        extractedGrandTotal: 110,
        grandTotalVariance: 0,
        calculatedBalanceDue: 110,
        extractedBalanceDue: 110,
        balanceDueVariance: 0,
        status: 'EXACT_MATCH',
        discrepancies: [],
        isVerified: true,
      },
      discrepancies: [],
      auditNotes: [],
    };

    const validXlsx: XlsxVerificationReport = {
      isValid: true,
      sheetNames: ['Document Summary', 'Line Items', 'Reconciliation & Audit'],
      totalRows: 20,
      formulaCount: 5,
      errors: [],
    };

    it('proves AI second-pass CANNOT override deterministic reconciliation mismatch', () => {
      const failedReconciliation: FinancialReconciliationReport = {
        ...validReconciliation,
        overallStatus: 'DISCREPANCY',
        isVerified: false,
        discrepancies: ['Subtotal discrepancy of $5.00'],
      };

      const gate = evaluateFinalVerificationGate({
        reconciliation: failedReconciliation,
        secondPass: { isVerified: true, confidenceScore: 1.0, issuesFound: [], correctionsNeeded: [], verifierNotes: 'AI claims verified' },
        completeness: { isComplete: true, coverage: {} as any, missingCrucialFields: [], notes: [] },
        semanticValidation: { isValid: true, warnings: [], errors: [] },
        xlsxVerification: validXlsx,
      });

      expect(gate.isVerified).toBe(false);
      expect(gate.reconciliationVerified).toBe(false);
      expect(gate.secondPassVerified).toBe(true);
      expect(gate.gateFailureReasons[0]).toContain('Deterministic financial reconciliation failed');
    });

    it('proves second-pass discrepancy prevents final verification even when math reconciles', () => {
      const gate = evaluateFinalVerificationGate({
        reconciliation: validReconciliation,
        secondPass: { isVerified: false, confidenceScore: 0.4, issuesFound: ['Line item 3 omitted from extraction'], correctionsNeeded: ['Add line item 3'], verifierNotes: 'Omission detected' },
        completeness: { isComplete: true, coverage: {} as any, missingCrucialFields: [], notes: [] },
        semanticValidation: { isValid: true, warnings: [], errors: [] },
        xlsxVerification: validXlsx,
      });

      expect(gate.isVerified).toBe(false);
      expect(gate.reconciliationVerified).toBe(true);
      expect(gate.secondPassVerified).toBe(false);
      expect(gate.gateFailureReasons[0]).toContain('Second-pass audit verification failed');
    });

    it('proves corrupt XLSX integrity prevents final verification', () => {
      const corruptXlsx: XlsxVerificationReport = {
        isValid: false,
        sheetNames: ['Document Summary'],
        totalRows: 1,
        formulaCount: 0,
        errors: ['Missing required worksheet: Line Items'],
      };

      const gate = evaluateFinalVerificationGate({
        reconciliation: validReconciliation,
        secondPass: { isVerified: true, confidenceScore: 1.0, issuesFound: [], correctionsNeeded: [], verifierNotes: 'Passed' },
        completeness: { isComplete: true, coverage: {} as any, missingCrucialFields: [], notes: [] },
        semanticValidation: { isValid: true, warnings: [], errors: [] },
        xlsxVerification: corruptXlsx,
      });

      expect(gate.isVerified).toBe(false);
      expect(gate.xlsxVerified).toBe(false);
      expect(gate.gateFailureReasons[0]).toContain('Spreadsheet integrity verification failed');
    });

    it('achieves isVerified=true when all 5 pillars pass', () => {
      const gate = evaluateFinalVerificationGate({
        reconciliation: validReconciliation,
        secondPass: { isVerified: true, confidenceScore: 1.0, issuesFound: [], correctionsNeeded: [], verifierNotes: 'Passed' },
        completeness: { isComplete: true, coverage: {} as any, missingCrucialFields: [], notes: [] },
        semanticValidation: { isValid: true, warnings: [], errors: [] },
        xlsxVerification: validXlsx,
      });

      expect(gate.isVerified).toBe(true);
      expect(gate.gateFailureReasons).toHaveLength(0);
    });
  });
});
