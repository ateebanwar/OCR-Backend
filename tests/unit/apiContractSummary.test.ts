import { describe, it, expect } from 'vitest';
import {
  DocumentSummaryInfo,
  FinancialSummaryInfo,
  VerificationSummaryInfo,
  XlsxSummaryInfo,
  ConversionSummary,
  conversionSummarySchema,
  documentSummarySchema,
  financialSummarySchema,
  verificationSummarySchema,
  xlsxSummarySchema,
} from '../../src/domain/summary';
import { generateFinancialWorkbook } from '../../src/spreadsheet/xlsxGenerator';
import { verifyXlsxBuffer } from '../../src/spreadsheet/xlsxVerifier';
import { DocumentProcessingService } from '../../src/services/DocumentProcessingService';
import { MockAIProvider } from '../mocks/MockAIProvider';
import fs from 'node:fs';
import path from 'node:path';
import { CanonicalFinancialDocument } from '../../src/domain/financial';
import { FinancialReconciliationReport } from '../../src/domain/processing';
import { getConfig } from '../../src/config/env';

const FIXTURES_DIR = path.resolve('tests/fixtures/documents');

describe('Frontend API Contract & Excel Summary Audit', () => {
  const mockCanonicalDoc: CanonicalFinancialDocument = {
    documentId: 'doc-summary-123',
    sourceFilename: 'commercial_tax_invoice.pdf',
    documentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    documentType: 'invoice',
    invoiceNumber: 'INV-2024-001',
    documentNumber: 'DOC-001',
    invoiceDate: '2024-03-15',
    dueDate: '2024-04-15',
    purchaseOrderNumber: 'PO-999',
    referenceNumbers: ['REF-A', 'REF-B'],
    currency: 'USD',
    language: 'en',
    processingTimestamp: new Date().toISOString(),
    vendor: {
      name: 'Acme Industrial Solutions',
      address: '123 Tech Way, San Jose, CA',
      taxId: 'US-987654321',
      email: 'billing@acme.com',
      phone: '+1-408-555-0100',
      contactPerson: 'Jane Doe',
    },
    customer: {
      name: 'Global Enterprise Corp',
      address: '456 Market St, New York, NY',
      taxId: 'US-123456789',
      email: 'ap@globalenterprise.com',
      phone: '+1-212-555-0200',
      contactPerson: 'John Smith',
    },
    lineItems: [
      {
        lineNumber: 1,
        description: 'Cloud Infrastructure Management Suite',
        sku: 'SKU-CLOUD-01',
        quantity: 2,
        unit: 'license',
        unitPrice: 500.0,
        discount: 50.0,
        taxRate: 0.1,
        taxAmount: 95.0,
        lineSubtotal: 950.0,
        lineTotal: 1045.0,
      },
    ],
    totals: {
      subtotal: 950.0,
      discountTotal: 50.0,
      taxTotal: 95.0,
      taxesBreakdown: [{ name: 'State Sales Tax', rate: 0.1, amount: 95.0 }],
      shippingCharges: 15.0,
      additionalCharges: 5.0,
      rounding: 0.0,
      grandTotal: 1065.0,
      paidAmount: 200.0,
      balanceDue: 865.0,
    },
    payment: {
      paymentTerms: 'Net 30',
      dueDate: '2024-04-15',
      paymentMethod: 'ACH',
      bankDetails: {
        bankName: 'Silicon Valley Bank',
        accountNumber: '9988776655',
        routingNumber: '121000358',
        iban: null,
        swiftBic: null,
      },
      paymentReference: 'INV-2024-001',
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

  const mockReconciliation: FinancialReconciliationReport = {
    documentId: 'doc-summary-123',
    reconciledAt: new Date().toISOString(),
    overallStatus: 'EXACT_MATCH',
    isVerified: true,
    toleranceApplied: 0.0,
    currency: 'USD',
    currencyPrecision: 2,
    conventions: {
      subtotalConvention: 'NET',
      taxConvention: 'PER_LINE',
      sourceRoundingApplied: 0.0,
    },
    lineItems: [],
    totals: {
      calculatedSubtotal: 950.0,
      extractedSubtotal: 950.0,
      subtotalVariance: 0.0,
      calculatedTaxTotal: 95.0,
      extractedTaxTotal: 95.0,
      taxVariance: 0.0,
      calculatedGrandTotal: 1065.0,
      extractedGrandTotal: 1065.0,
      grandTotalVariance: 0.0,
      calculatedBalanceDue: 865.0,
      extractedBalanceDue: 865.0,
      balanceDueVariance: 0.0,
      status: 'EXACT_MATCH',
      discrepancies: [],
      isVerified: true,
    },
    discrepancies: [],
    auditNotes: ['All values reconciled perfectly with zero variance.'],
  };

  describe('Spreadsheet (XLSX) Verifier Enhancements', () => {
    it('verifies actual generated workbook and populates sheetCount, totalColumns, and worksheetValidation', async () => {
      const xlsxBuffer = await generateFinancialWorkbook(mockCanonicalDoc, mockReconciliation);
      const report = await verifyXlsxBuffer(xlsxBuffer);

      expect(report.isValid).toBe(true);
      expect(report.sheetCount).toBe(3);
      expect(report.sheetNames).toEqual(['Document Summary', 'Line Items', 'Reconciliation & Audit']);
      expect(report.totalRows).toBeGreaterThan(15);
      expect(report.totalColumns).toBeGreaterThanOrEqual(6);
      expect(report.formulaCount).toBeGreaterThan(0);
      expect(report.errors).toHaveLength(0);

      // Verify worksheet-level validation details
      expect(report.sheets).toHaveLength(3);
      for (const sheet of report.sheets) {
        expect(sheet.name).toBeTypeOf('string');
        expect(sheet.rowCount).toBeGreaterThan(0);
        expect(sheet.columnCount).toBeGreaterThan(0);
        expect(sheet.formulaCount).toBeGreaterThanOrEqual(0);
        expect(sheet.isValid).toBe(true);
      }

      // Check specific sheets
      const summarySheet = report.sheets.find(s => s.name === 'Document Summary');
      expect(summarySheet).toBeDefined();
      expect(summarySheet?.rowCount).toBeGreaterThan(5);

      const itemsSheet = report.sheets.find(s => s.name === 'Line Items');
      expect(itemsSheet).toBeDefined();
      expect(itemsSheet?.formulaCount).toBeGreaterThanOrEqual(1);

      const auditSheet = report.sheets.find(s => s.name === 'Reconciliation & Audit');
      expect(auditSheet).toBeDefined();
    });
  });

  describe('Contract Schema Validations (Zod)', () => {
    it('validates a complete, authentic ConversionSummary through Zod', () => {
      const summary: ConversionSummary = {
        document: {
          sourceFilename: 'commercial_tax_invoice.pdf',
          documentType: 'invoice',
          invoiceNumber: 'INV-2024-001',
          documentNumber: 'DOC-001',
          invoiceDate: '2024-03-15',
          dueDate: '2024-04-15',
          purchaseOrderNumber: 'PO-999',
          referenceNumbers: ['REF-A', 'REF-B'],
          vendorName: 'Acme Industrial Solutions',
          customerName: 'Global Enterprise Corp',
          currency: 'USD',
          language: 'en',
          totalPdfPages: 1,
          processedPages: 1,
          extractedPages: [1],
          failedPages: [],
          skippedPages: [],
          extractionCompleteness: 1.0,
          isFullyCovered: true,
          extractedLineItemCount: 1,
        },
        financial: {
          currency: 'USD',
          subtotal: 950.0,
          discountTotal: 50.0,
          taxTotal: 95.0,
          taxBreakdown: [{ name: 'State Sales Tax', rate: 0.1, amount: 95.0 }],
          shippingCharges: 15.0,
          additionalCharges: 5.0,
          rounding: 0.0,
          grandTotal: 1065.0,
          paidAmount: 200.0,
          balanceDue: 865.0,

          overallReconciliationStatus: 'EXACT_MATCH',
          reconciliationVerificationStatus: true,
          calculatedSubtotal: 950.0,
          extractedSubtotal: 950.0,
          subtotalVariance: 0.0,
          calculatedTaxTotal: 95.0,
          extractedTaxTotal: 95.0,
          taxVariance: 0.0,
          calculatedGrandTotal: 1065.0,
          extractedGrandTotal: 1065.0,
          grandTotalVariance: 0.0,
          calculatedBalanceDue: 865.0,
          extractedBalanceDue: 865.0,
          balanceDueVariance: 0.0,
          discrepancies: [],
          reconciliationConventions: {
            subtotalConvention: 'NET',
            taxConvention: 'PER_LINE',
            sourceRoundingApplied: 0.0,
          },
          toleranceApplied: 0.0,
          currencyPrecision: 2,
          sourceRoundingApplied: 0.0,
        },
        verification: {
          isVerified: true,
          reconciliationVerified: true,
          secondPassVerified: true,
          completenessVerified: true,
          semanticVerified: true,
          xlsxVerified: true,
          verificationGateStatus: 'PASSED',
          gateFailureReasons: [],
          discrepancies: [],
        },
        xlsx: {
          generatedXlsxFilename: 'commercial_tax_invoice_financial_report.xlsx',
          xlsxValid: true,
          sheetCount: 3,
          sheetNames: ['Document Summary', 'Line Items', 'Reconciliation & Audit'],
          totalRowCount: 25,
          totalColumnCount: 10,
          formulaCount: 3,
          workbookErrors: [],
          worksheetValidation: [
            { name: 'Document Summary', rowCount: 10, columnCount: 4, formulaCount: 0, isValid: true },
            { name: 'Line Items', rowCount: 5, columnCount: 10, formulaCount: 2, isValid: true },
            { name: 'Reconciliation & Audit', rowCount: 10, columnCount: 6, formulaCount: 1, isValid: true },
          ],
          summarySheetPresent: true,
          lineItemsSheetPresent: true,
          auditSheetPresent: true,
        },
      };

      const parsed = conversionSummarySchema.parse(summary);
      expect(parsed).toEqual(summary);
    });

    it('validates a Statement with nullable invoiceDate and empty line items', () => {
      const statementDocSummary: DocumentSummaryInfo = {
        sourceFilename: 'monthly_statement.pdf',
        documentType: 'statement',
        invoiceNumber: null,
        documentNumber: 'STMT-2024-03',
        invoiceDate: null,
        dueDate: null,
        purchaseOrderNumber: null,
        referenceNumbers: [],
        vendorName: 'Bank of Finance',
        customerName: 'Enterprise Client',
        currency: 'EUR',
        language: 'de',
        totalPdfPages: 2,
        processedPages: 2,
        extractedPages: [1, 2],
        failedPages: [],
        skippedPages: [],
        extractionCompleteness: 1.0,
        isFullyCovered: true,
        extractedLineItemCount: 0,
      };

      const parsed = documentSummarySchema.parse(statementDocSummary);
      expect(parsed.invoiceNumber).toBeNull();
      expect(parsed.invoiceDate).toBeNull();
      expect(parsed.documentType).toBe('statement');
    });

    it('validates a FinancialSummary with zero arbitrary tolerance', () => {
      const finSummary: FinancialSummaryInfo = {
        currency: 'GBP',
        subtotal: 100.0,
        discountTotal: null,
        taxTotal: 20.0,
        taxBreakdown: null,
        shippingCharges: null,
        additionalCharges: null,
        rounding: null,
        grandTotal: 120.0,
        paidAmount: null,
        balanceDue: 120.0,
        overallReconciliationStatus: 'EXACT_MATCH',
        reconciliationVerificationStatus: true,
        calculatedSubtotal: 100.0,
        extractedSubtotal: 100.0,
        subtotalVariance: 0.0,
        calculatedTaxTotal: 20.0,
        extractedTaxTotal: 20.0,
        taxVariance: 0.0,
        calculatedGrandTotal: 120.0,
        extractedGrandTotal: 120.0,
        grandTotalVariance: 0.0,
        calculatedBalanceDue: 120.0,
        extractedBalanceDue: 120.0,
        balanceDueVariance: 0.0,
        discrepancies: [],
        toleranceApplied: 0.0,
        currencyPrecision: 2,
        sourceRoundingApplied: 0.0,
      };

      const parsed = financialSummarySchema.parse(finSummary);
      expect(parsed.toleranceApplied).toBe(0.0);
      expect(parsed.overallReconciliationStatus).toBe('EXACT_MATCH');
    });
  });

  describe('DocumentProcessingService End-to-End Contract Integration', () => {
    it('produces the full authoritative summary while preserving all existing top-level fields', async () => {
      const config = getConfig();
      const mockAiProvider = new MockAIProvider();
      mockAiProvider.mockExtractionData = {
        documentType: 'invoice',
        invoiceNumber: 'INV-CONTRACT-001',
        documentNumber: null,
        invoiceDate: '2024-05-01',
        dueDate: '2024-06-01',
        purchaseOrderNumber: 'PO-7788',
        referenceNumbers: [],
        currency: 'USD',
        language: 'en',
        vendor: {
          name: 'Vendor Inc',
          address: '100 Street',
          taxId: 'US-111',
          email: 'v@inc.com',
          phone: null,
          contactPerson: null,
        },
        customer: {
          name: 'Customer LLC',
          address: '200 Avenue',
          taxId: 'US-222',
          email: 'c@llc.com',
          phone: null,
          contactPerson: null,
        },
        lineItems: [
          {
            lineNumber: 1,
            description: 'Professional Services',
            sku: null,
            quantity: 1,
            unit: 'hr',
            unitPrice: 200.0,
            discount: null,
            taxRate: 0.1,
            taxAmount: 20.0,
            lineSubtotal: 200.0,
            lineTotal: 220.0,
          },
        ],
        totals: {
          subtotal: 200.0,
          discountTotal: null,
          taxTotal: 20.0,
          taxesBreakdown: null,
          shippingCharges: null,
          additionalCharges: null,
          rounding: null,
          grandTotal: 220.0,
          paidAmount: null,
          balanceDue: 220.0,
        },
        payment: null,
        pageCount: 1,
      };

      const service = new DocumentProcessingService(mockAiProvider, config);
      const pdfBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'test01_simple_invoice.pdf'));
      const result = await service.processDocument(pdfBuffer, 'contract_test.pdf');

      // 1. Verify 100% Backward Compatibility of Existing Fields
      expect(result.success).toBe(true);
      expect(result.documentId).toBeTypeOf('string');
      expect(result.sourceFilename).toBe('contract_test.pdf');
      expect(result.documentHash).toBeTypeOf('string');
      expect(result.isVerified).toBe(true);
      expect(result.document).toBeDefined();
      expect(result.reconciliation).toBeDefined();
      expect(result.auditTrail).toBeDefined();
      expect(result.xlsxBase64).toBeTypeOf('string');
      expect(result.xlsxVerification).toBeDefined();

      // 2. Verify New Authoritative Summary Contract
      expect(result.summary).toBeDefined();
      const { summary } = result;

      // Document Summary
      expect(summary.document.sourceFilename).toBe('contract_test.pdf');
      expect(summary.document.documentType).toBe('invoice');
      expect(summary.document.invoiceNumber).toBe('INV-CONTRACT-001');
      expect(summary.document.vendorName).toBe('Vendor Inc');
      expect(summary.document.customerName).toBe('Customer LLC');
      expect(summary.document.currency).toBe('USD');
      expect(summary.document.totalPdfPages).toBe(1);
      expect(summary.document.extractedLineItemCount).toBe(1);
      expect(summary.document.isFullyCovered).toBe(true);

      // Financial Summary
      expect(summary.financial.currency).toBe('USD');
      expect(summary.financial.subtotal).toBe(200.0);
      expect(summary.financial.taxTotal).toBe(20.0);
      expect(summary.financial.grandTotal).toBe(220.0);
      expect(summary.financial.overallReconciliationStatus).toBe('EXACT_MATCH');
      expect(summary.financial.toleranceApplied).toBe(0.0);
      expect(summary.financial.calculatedGrandTotal).toBe(220.0);
      expect(summary.financial.extractedGrandTotal).toBe(220.0);
      expect(summary.financial.grandTotalVariance).toBe(0.0);
      expect(summary.financial.discrepancies).toHaveLength(0);

      // Verification Summary
      expect(summary.verification.isVerified).toBe(true);
      expect(summary.verification.reconciliationVerified).toBe(true);
      expect(summary.verification.secondPassVerified).toBe(true);
      expect(summary.verification.completenessVerified).toBe(true);
      expect(summary.verification.semanticVerified).toBe(true);
      expect(summary.verification.xlsxVerified).toBe(true);
      expect(summary.verification.verificationGateStatus).toBe('PASSED');
      expect(summary.verification.gateFailureReasons).toHaveLength(0);

      // Excel (XLSX) Summary
      expect(summary.xlsx.generatedXlsxFilename).toBe('contract_test_financial_report.xlsx');
      expect(summary.xlsx.xlsxValid).toBe(true);
      expect(summary.xlsx.sheetCount).toBe(3);
      expect(summary.xlsx.sheetNames).toEqual(['Document Summary', 'Line Items', 'Reconciliation & Audit']);
      expect(summary.xlsx.totalRowCount).toBeGreaterThan(10);
      expect(summary.xlsx.totalColumnCount).toBeGreaterThanOrEqual(4);
      expect(summary.xlsx.formulaCount).toBeGreaterThan(0);
      expect(summary.xlsx.workbookErrors).toHaveLength(0);
      expect(summary.xlsx.summarySheetPresent).toBe(true);
      expect(summary.xlsx.lineItemsSheetPresent).toBe(true);
      expect(summary.xlsx.auditSheetPresent).toBe(true);

      // Worksheet Breakdown
      expect(summary.xlsx.worksheetValidation).toHaveLength(3);
      for (const ws of summary.xlsx.worksheetValidation) {
        expect(ws.rowCount).toBeGreaterThan(0);
        expect(ws.columnCount).toBeGreaterThan(0);
        expect(ws.isValid).toBe(true);
      }
    });
  });
});
