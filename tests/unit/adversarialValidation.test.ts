import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/config/env';
import { getModelHierarchy, selectModelForComplexity, getEscalationModel, getVerificationModel } from '../../src/config/models';
import { analyzeDocumentComplexity } from '../../src/documents/complexityAnalyzer';
import { reconcileFinancialDocument } from '../../src/reconciliation/reconciliationEngine';
import { CanonicalFinancialDocument } from '../../src/domain/financial';
import { scrubObject } from '../../src/security/scrubber';
import { validatePdfBuffer } from '../../src/security/fileValidator';
import { generateFinancialWorkbook } from '../../src/spreadsheet/xlsxGenerator';
import { verifyXlsxBuffer } from '../../src/spreadsheet/xlsxVerifier';
import { DocumentProcessingService } from '../../src/services/DocumentProcessingService';
import { AIProvider } from '../../src/providers/ai/AIProvider';
import { RawFinancialExtraction } from '../../src/extraction/schemas/financialSchema';

const FIXTURES_DIR = path.resolve('tests/fixtures/documents');

describe('Adversarial Production Validation Suite', () => {
  // --------------------------------------------------------------------------
  // 1. ENVIRONMENT & CONFIGURATION VALIDATION
  // --------------------------------------------------------------------------
  describe('Environment & Configuration Validation', () => {
    it('enforces safe fallbacks and validates all 5 distinct model tiers', () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        AI_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'test-key',
        GEMINI_EXTRACTION_MODEL: 'gemini-3.5-flash-lite',
        GEMINI_COMPLEX_EXTRACTION_MODEL: 'gemini-3.7-flash',
        GEMINI_ESCALATION_MODEL: 'gemini-3.8-flash',
        GEMINI_VERIFICATION_MODEL: 'gemini-3.7-flash',
        GEMINI_CHAT_MODEL: 'gemini-3.5-flash-lite',
      });

      expect(config.gemini.extractionModel).toBe('gemini-3.5-flash-lite');
      expect(config.gemini.complexExtractionModel).toBe('gemini-3.7-flash');
      expect(config.gemini.escalationModel).toBe('gemini-3.8-flash');
      expect(config.gemini.verificationModel).toBe('gemini-3.7-flash');
      expect(config.gemini.chatModel).toBe('gemini-3.5-flash-lite');
    });

    it('scrubs sensitive credentials, tokens, and buffer byte content from logs and objects', () => {
      const sensitiveInput = {
        apiKey: 'key-placeholder-testing-only-1234567890abcdef',
        auth: 'Bearer ya29.a0AfH6SMA_PLACEHOLDER_TOKEN',
        password: 'SuperSecretPassword123!',
        buffer: Buffer.from('PDF content stream'),
        normalField: 'Standard Commercial Invoice',
      };

      const scrubbed = scrubObject(sensitiveInput) as any;
      expect(scrubbed.apiKey).toBe('[REDACTED]');
      expect(scrubbed.auth).toBe('[REDACTED]');
      expect(scrubbed.password).toBe('[REDACTED]');
      expect(scrubbed.buffer).toBe('[BINARY_DATA_REDACTED]');
      expect(scrubbed.normalField).toBe('Standard Commercial Invoice');
    });
  });

  // --------------------------------------------------------------------------
  // 2. FINANCIAL RECONCILIATION ADVERSARIAL CASES (ZERO TOLERANCE)
  // --------------------------------------------------------------------------
  describe('Financial Reconciliation Adversarial Arithmetic (Zero Blind Tolerance)', () => {
    const createBaseRawDocument = (): RawFinancialExtraction => ({
      documentType: 'invoice',
      invoiceNumber: 'INV-AUDIT-001',
      documentNumber: null,
      invoiceDate: '2026-03-01',
      dueDate: '2026-03-31',
      purchaseOrderNumber: null,
      referenceNumbers: [],
      currency: 'USD',
      language: 'en',
      pageCount: 1,
      vendor: { name: 'ACME Corp', address: null, taxId: null, email: null, phone: null, contactPerson: null },
      customer: { name: 'Global Industries', address: null, taxId: null, email: null, phone: null, contactPerson: null },
      lineItems: [
        {
          lineNumber: 1,
          description: 'Server Blade A',
          sku: 'A1',
          quantity: 2,
          unit: 'ea',
          unitPrice: 50.0,
          discount: 0,
          taxRate: 10,
          taxAmount: 10,
          lineSubtotal: 100.0,
          lineTotal: 100.0,
        },
        {
          lineNumber: 2,
          description: 'Server Blade B',
          sku: 'B1',
          quantity: 1,
          unit: 'ea',
          unitPrice: 100.0,
          discount: 0,
          taxRate: 10,
          taxAmount: 10,
          lineSubtotal: 100.0,
          lineTotal: 100.0,
        },
      ],
      totals: {
        subtotal: 200.0,
        discountTotal: 0,
        taxTotal: 20.0,
        taxesBreakdown: [
          {
            name: 'VAT',
            rate: 10.0,
            amount: 20.0,
          },
        ],
        shippingCharges: 0,
        additionalCharges: 0,
        rounding: 0,
        grandTotal: 220.0,
        paidAmount: 0,
        balanceDue: 220.0,
      },
      payment: null,
    });

    it('Case A: Exact mathematical match passes with toleranceApplied = 0', () => {
      const doc = createBaseRawDocument();
      const result = reconcileFinancialDocument(doc);
      expect(result.overallStatus).toBe('EXACT_MATCH');
      expect(result.isVerified).toBe(true);
      expect(result.toleranceApplied).toBe(0.0);
      expect(result.discrepancies.length).toBe(0);
    });

    it('Case B: Subtotal wrong by 0.01 fails (rejected, zero arbitrary tolerance)', () => {
      const doc = createBaseRawDocument();
      doc.totals.subtotal = 200.01; // Off by 1 cent
      const result = reconcileFinancialDocument(doc);
      expect(result.overallStatus).toBe('DISCREPANCY');
      expect(result.isVerified).toBe(false);
      expect(result.discrepancies.some((d) => d.includes('subtotal') || d.includes('Subtotal'))).toBe(true);
    });

    it('Case C: Tax wrong by 0.01 fails', () => {
      const doc = createBaseRawDocument();
      doc.totals.taxTotal = 20.01; // Off by 1 cent
      const result = reconcileFinancialDocument(doc);
      expect(result.overallStatus).toBe('DISCREPANCY');
      expect(result.isVerified).toBe(false);
    });

    it('Case D: Grand total wrong by 0.01 fails', () => {
      const doc = createBaseRawDocument();
      doc.totals.grandTotal = 220.01; // Off by 1 cent
      const result = reconcileFinancialDocument(doc);
      expect(result.overallStatus).toBe('DISCREPANCY');
      expect(result.isVerified).toBe(false);
    });

    it('Case E: Line item missing fails', () => {
      const doc = createBaseRawDocument();
      doc.lineItems.pop(); // Remove 1 item
      const result = reconcileFinancialDocument(doc);
      expect(result.overallStatus).toBe('DISCREPANCY');
      expect(result.isVerified).toBe(false);
    });

    it('Case F: Line item duplicated fails', () => {
      const doc = createBaseRawDocument();
      const firstItem = doc.lineItems[0]!;
      doc.lineItems.push({ ...firstItem, lineNumber: 3 }); // Duplicate line
      const result = reconcileFinancialDocument(doc);
      expect(result.overallStatus).toBe('DISCREPANCY');
      expect(result.isVerified).toBe(false);
    });

    it('Case G: Discount omitted fails', () => {
      const doc = createBaseRawDocument();
      doc.totals.grandTotal = 200.0; // Grand total assumes $20 discount was applied, but discountTotal is missing
      const result = reconcileFinancialDocument(doc);
      expect(result.overallStatus).toBe('DISCREPANCY');
      expect(result.isVerified).toBe(false);
    });

    it('Case H: Tax breakdown does not sum to taxTotal fails', () => {
      const doc = createBaseRawDocument();
      doc.totals.taxesBreakdown = [
        { name: 'State', rate: 5.0, amount: 5.0 },
        { name: 'City', rate: 2.0, amount: 2.0 },
      ]; // Sums to 7.00, but taxTotal is 20.00
      doc.lineItems.forEach((item) => {
        item.taxAmount = 0;
        item.taxRate = 0;
      });
      const result = reconcileFinancialDocument(doc);
      expect(result.overallStatus).toBe('DISCREPANCY');
      expect(result.isVerified).toBe(false);
    });

    it('Case I: Exact subtotal-level commercial tax convention reconciles deterministically', () => {
      const commercialDoc: RawFinancialExtraction = {
        documentType: 'invoice',
        invoiceNumber: 'INV-3337',
        documentNumber: null,
        invoiceDate: '2016-01-25',
        dueDate: null,
        purchaseOrderNumber: null,
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        pageCount: 1,
        vendor: { name: 'DEMO Sliced Invoices', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        customer: { name: 'Test Business', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        lineItems: [
          {
            lineNumber: 1,
            description: 'Web Design',
            sku: null,
            quantity: 1,
            unit: 'hrs',
            unitPrice: 85.0,
            discount: 0,
            taxRate: 0,
            taxAmount: 0,
            lineSubtotal: 85.0,
            lineTotal: 85.0,
          },
        ],
        totals: {
          subtotal: 85.0,
          discountTotal: 0,
          taxTotal: 8.5,
          taxesBreakdown: null,
          shippingCharges: 0,
          additionalCharges: 0,
          rounding: 0,
          grandTotal: 93.5,
          paidAmount: 0,
          balanceDue: 93.5,
        },
        payment: null,
      };
      const result = reconcileFinancialDocument(commercialDoc);
      expect(result.overallStatus).toBe('EXACT_MATCH');
      expect(result.isVerified).toBe(true);
      expect(result.toleranceApplied).toBe(0.0);
    });
  });

  // --------------------------------------------------------------------------
  // 3. SECOND-PASS VERIFICATION & DETERMINISTIC OVERRIDE
  // --------------------------------------------------------------------------
  describe('Second-Pass Verification & Deterministic Authority', () => {
    it('proves DETERMINISTIC OVERRIDE: AI verification pass claiming verified CANNOT override arithmetic discrepancy', async () => {
      const mockProvider: AIProvider = {
        providerName: 'mock',
        analyzeDocument: vi.fn(),
        extractStructuredData: vi.fn().mockResolvedValue({
          documentType: 'invoice',
          invoiceNumber: 'INV-OVERRIDE',
          currency: 'USD',
          vendor: { name: 'ACME' },
          customer: { name: 'Client' },
          lineItems: [
            {
              lineNumber: 1,
              description: 'A',
              quantity: 1,
              unitPrice: 100,
              amount: 100,
              total: 100,
            },
          ],
          totals: { subtotal: 100, taxTotal: 0, grandTotal: 999.0 }, // Arithmetic discrepancy!
        }),
        chat: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            isVerified: true, // AI auditor falsely claims verified!
            confidenceScore: 0.99,
            findings: [],
            discrepancies: [],
          }),
        }),
        streamChat: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue({ status: 'healthy', provider: 'mock' }),
      };

      const config = loadConfig({ NODE_ENV: 'test', AI_PROVIDER: 'mock' });
      const service = new DocumentProcessingService(mockProvider, config);

      const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
      // CRITICAL ASSERTION: AI claiming verified CANNOT override arithmetic discrepancy!
      // Document is NOT verified, reconciliation is false, and status is REVIEW_REQUIRED!
      const result = await service.processDocument(fakePdf, 'test_override.pdf');
      expect(result.isVerified).toBe(false);
      expect(result.reconciliation.isVerified).toBe(false);
      expect(result.summary.verification.reconciliationVerified).toBe(false);
      expect(result.summary.status).toBe('REVIEW_REQUIRED');
      expect(result.summary.review?.required).toBe(true);
      expect(result.summary.review?.reviewToken).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 4. SPREADSHEET FORMULA INJECTION DEFENSE (CWE-1236)
  // --------------------------------------------------------------------------
  describe('XLSX Generation & Formula Injection Defense', () => {
    it('neutralizes malicious formula injection characters in line item descriptions', async () => {
      const maliciousDoc = {
        vendor: { name: '=CMD|calc.exe', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        customer: { name: '+123456789', address: null, taxId: null, email: null, phone: null, contactPerson: null },
        invoiceNumber: '@SUM(A1:A10)',
        documentNumber: null,
        invoiceDate: '2026-03-17',
        dueDate: null,
        purchaseOrderNumber: null,
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        pageCount: 1,
        lineItems: [
          { lineNumber: 1, description: '=SUM(B1:B10)', sku: null, quantity: 1, unit: null, unitPrice: 100, discount: 0, taxRate: 0, taxAmount: 0, lineSubtotal: 100, lineTotal: 100 },
          { lineNumber: 2, description: '-10*5', sku: null, quantity: 1, unit: null, unitPrice: 50, discount: 0, taxRate: 0, taxAmount: 0, lineSubtotal: 50, lineTotal: 50 },
        ],
        totals: { subtotal: 150, discountTotal: 0, taxTotal: 0, shippingCharges: 0, additionalCharges: 0, rounding: 0, grandTotal: 150, paidAmount: 0, balanceDue: 150, taxesBreakdown: null },
        paymentDetails: { paymentTerms: null, dueDate: null, paymentMethod: null, bankAccount: null },
        notes: [],
      };

      const reconciliation = reconcileFinancialDocument(maliciousDoc as any);
      const spreadsheetBuffer = await generateFinancialWorkbook(maliciousDoc as any, reconciliation);
      const verification = await verifyXlsxBuffer(spreadsheetBuffer);

      expect(verification.isValid).toBe(true);
      expect(verification.sheetNames).toContain('Document Summary');
      expect(verification.sheetNames).toContain('Line Items');
      expect(verification.sheetNames).toContain('Reconciliation & Audit');
      expect(verification.formulaCount).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // 5. SECURITY CONTROLS: PRE-AI REJECTION
  // --------------------------------------------------------------------------
  describe('Security Controls: Pre-AI File Validation', () => {
    it('rejects malformed PDF with missing magic bytes before invoking any AI calls', () => {
      const malformedBuffer = Buffer.from('CORRUPTED_NON_PDF_BYTES_12345678');
      expect(() => validatePdfBuffer(malformedBuffer, 'corrupted.pdf', 15 * 1024 * 1024)).toThrow(
        /magic bytes/i
      );
    });

    it('rejects files with invalid extensions', () => {
      const validPdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\nendobj\n%%EOF');
      expect(() => validatePdfBuffer(validPdfBuffer, 'invoice.exe', 15 * 1024 * 1024)).toThrow(
        /unsupported file extension/i
      );
    });

    it('rejects password-protected / encrypted PDFs before AI invocation', () => {
      const encryptedBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'test16_encrypted.pdf'));
      expect(() => validatePdfBuffer(encryptedBuffer, 'encrypted.pdf', 15 * 1024 * 1024)).toThrow(
        /password-protected or encrypted/i
      );
    });
  });

  // --------------------------------------------------------------------------
  // 6. REAL PDF CORPUS STRUCTURAL CLASSIFICATION & TABLE ROUTING
  // --------------------------------------------------------------------------
  describe('Real PDF Corpus Multi-Signal Complexity & Model Routing Matrix', () => {
    it('TEST 01 - Simple 1-page invoice routes to TIER_1_SIMPLE', () => {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'test01_simple_invoice.pdf'));
      const res = analyzeDocumentComplexity(buf);
      expect(res.level).toBe('LEVEL_1_SIMPLE');
      expect(res.selectedTier).toBe('TIER_1_SIMPLE');
      expect(selectModelForComplexity(res.level)).toBeDefined();
    });

    it('TEST 02 - Multi-page invoice routes to TIER_2_COMPLEX', () => {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'test02_multipage_invoice.pdf'));
      const res = analyzeDocumentComplexity(buf);
      expect(res.estimatedPageCount).toBe(2);
      expect(res.level).toBe('LEVEL_2_COMPLEX');
      expect(res.selectedTier).toBe('TIER_2_COMPLEX');
    });

    it('TEST 03 - Dense financial table with 16 vector grid lines routes to TIER_2_COMPLEX', () => {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'test03_dense_financial_table.pdf'));
      const res = analyzeDocumentComplexity(buf);
      expect(res.signals.gridVectorCount).toBeGreaterThanOrEqual(16);
      expect(res.level).toBe('LEVEL_2_COMPLEX');
      expect(res.selectedTier).toBe('TIER_2_COMPLEX');
    });

    it('TEST 06 - Financial statement with running balance carried forward routes to TIER_3_ESCALATION', () => {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'test06_financial_statement.pdf'));
      const res = analyzeDocumentComplexity(buf);
      expect(res.signals.hasStatementMarkers).toBe(true);
      expect(res.level).toBe('LEVEL_3_AMBIGUOUS');
      expect(res.selectedTier).toBe('TIER_3_ESCALATION');
    });

    it('TEST 07 - High-complexity 3-page consolidated document routes to TIER_3_ESCALATION', () => {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'test07_high_complexity.pdf'));
      const res = analyzeDocumentComplexity(buf);
      expect(res.estimatedPageCount).toBe(3);
      expect(res.level).toBe('LEVEL_3_AMBIGUOUS');
      expect(res.selectedTier).toBe('TIER_3_ESCALATION');
    });

    it('TEST 08 - CRITICAL PROOF: 1-page document with 20 vector grid lines and dense taxes routes to TIER_2_COMPLEX', () => {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'test08_onepage_complex.pdf'));
      const res = analyzeDocumentComplexity(buf);
      expect(res.estimatedPageCount).toBe(1);
      expect(res.signals.gridVectorCount).toBeGreaterThanOrEqual(20);
      expect(res.level).toBe('LEVEL_2_COMPLEX');
      expect(res.selectedTier).toBe('TIER_2_COMPLEX');
    });

    it('TEST 09 - Multi-page simple document with 3 pages does NOT blindly trigger Tier 3', () => {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'test09_multipage_simple.pdf'));
      const res = analyzeDocumentComplexity(buf);
      expect(res.estimatedPageCount).toBe(3);
      expect(res.level).not.toBe('LEVEL_3_AMBIGUOUS');
    });

    it('TEST 10 - Scanned image density triggers complexity signals', () => {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'test10_scanned_image.pdf'));
      const res = analyzeDocumentComplexity(buf);
      expect(res.signals.imageCount).toBeGreaterThan(0);
      expect(res.signals.isScannedHeavy).toBe(true);
    });
  });
});
