import ExcelJS from 'exceljs';
import { CanonicalFinancialDocument } from '../domain/financial';
import { FinancialReconciliationReport } from '../domain/processing';
import { SpreadsheetGenerationError } from '../errors/AppError';
import { getConfig } from '../config/env';

export interface XlsxGenerationOptions {
  includeAuditSheet?: boolean;
}

/**
 * Neutralizes Excel Formula Injection (CWE-1236 / CSV Injection).
 * If untrusted user or document text begins with dangerous execution tokens
 * ('=', '+', '-', '@', '\t', '\r'), prepends an apostrophe (') so Microsoft Excel
 * and LibreOffice render it strictly as plain text without executing formulas or DDE.
 */
export function sanitizeSpreadsheetText(
  value: string | null | undefined,
  defaultValue = 'N/A'
): string {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  const str = String(value);
  if (str.length === 0) {
    return '';
  }
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

export async function generateFinancialWorkbook(
  document: CanonicalFinancialDocument,
  reconciliation: FinancialReconciliationReport,
  options: XlsxGenerationOptions = { includeAuditSheet: true }
): Promise<Buffer> {
  try {
    const config = getConfig();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Financial Document Intelligence Engine';
    workbook.lastModifiedBy = 'Financial Document Intelligence Engine';
    workbook.created = new Date();
    workbook.modified = new Date();

    const currencySymbol = sanitizeSpreadsheetText(document.currency || 'USD', 'USD');

    // ==========================================
    // SHEET 1: Document Summary
    // ==========================================
    const summarySheet = workbook.addWorksheet('Document Summary', {
      views: [{ showGridLines: true }],
      pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });

    summarySheet.columns = [
      { width: 25 },
      { width: 35 },
      { width: 25 },
      { width: 35 },
    ];

    // Title banner
    summarySheet.mergeCells('A1:D1');
    const titleCell = summarySheet.getCell('A1');
    titleCell.value = 'FINANCIAL DOCUMENT SUMMARY';
    titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' }, // Slate-800
    };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    summarySheet.getRow(1).height = 36;

    // Document Information Section (Sanitized against Formula Injection)
    summarySheet.getCell('A3').value = 'Document ID:';
    summarySheet.getCell('B3').value = sanitizeSpreadsheetText(document.documentId);
    summarySheet.getCell('C3').value = 'Document Type:';
    summarySheet.getCell('D3').value = sanitizeSpreadsheetText(document.documentType.toUpperCase());

    summarySheet.getCell('A4').value = 'Invoice Number:';
    summarySheet.getCell('B4').value = sanitizeSpreadsheetText(document.invoiceNumber);
    summarySheet.getCell('C4').value = 'Invoice Date:';
    summarySheet.getCell('D4').value = sanitizeSpreadsheetText(document.invoiceDate);

    summarySheet.getCell('A5').value = 'PO Number:';
    summarySheet.getCell('B5').value = sanitizeSpreadsheetText(document.purchaseOrderNumber);
    summarySheet.getCell('C5').value = 'Due Date:';
    summarySheet.getCell('D5').value = sanitizeSpreadsheetText(document.dueDate);

    summarySheet.getCell('A6').value = 'Currency:';
    summarySheet.getCell('B6').value = currencySymbol;
    summarySheet.getCell('C6').value = 'Source File:';
    summarySheet.getCell('D6').value = sanitizeSpreadsheetText(document.sourceFilename);

    // Section Headers styling
    summarySheet.mergeCells('A8:B8');
    summarySheet.getCell('A8').value = 'VENDOR / SUPPLIER';
    summarySheet.mergeCells('C8:D8');
    summarySheet.getCell('C8').value = 'CUSTOMER / BUYER';

    ['A8', 'C8'].forEach(pos => {
      const cell = summarySheet.getCell(pos);
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
      cell.alignment = { horizontal: 'left', indent: 1 };
    });

    // Vendor info (Sanitized against Formula Injection)
    summarySheet.getCell('A9').value = 'Name:';
    summarySheet.getCell('B9').value = sanitizeSpreadsheetText(document.vendor?.name);
    summarySheet.getCell('A10').value = 'Tax/VAT ID:';
    summarySheet.getCell('B10').value = sanitizeSpreadsheetText(document.vendor?.taxId);
    summarySheet.getCell('A11').value = 'Address:';
    summarySheet.getCell('B11').value = sanitizeSpreadsheetText(document.vendor?.address);
    summarySheet.getCell('A12').value = 'Email:';
    summarySheet.getCell('B12').value = sanitizeSpreadsheetText(document.vendor?.email);
    summarySheet.getCell('A13').value = 'Phone:';
    summarySheet.getCell('B13').value = sanitizeSpreadsheetText(document.vendor?.phone);

    // Customer info (Sanitized against Formula Injection)
    summarySheet.getCell('C9').value = 'Name:';
    summarySheet.getCell('D9').value = sanitizeSpreadsheetText(document.customer?.name);
    summarySheet.getCell('C10').value = 'Tax ID:';
    summarySheet.getCell('D10').value = sanitizeSpreadsheetText(document.customer?.taxId);
    summarySheet.getCell('C11').value = 'Address:';
    summarySheet.getCell('D11').value = sanitizeSpreadsheetText(document.customer?.address);
    summarySheet.getCell('C12').value = 'Email:';
    summarySheet.getCell('D12').value = sanitizeSpreadsheetText(document.customer?.email);
    summarySheet.getCell('C13').value = 'Phone:';
    summarySheet.getCell('D13').value = sanitizeSpreadsheetText(document.customer?.phone);

    // Financial Totals Section
    summarySheet.mergeCells('A15:D15');
    const totHeader = summarySheet.getCell('A15');
    totHeader.value = 'FINANCIAL TOTALS';
    totHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    totHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } }; // Teal-700
    totHeader.alignment = { horizontal: 'left', indent: 1 };

    summarySheet.getCell('A16').value = 'Subtotal:';
    const subtotalCell = summarySheet.getCell('B16');
    subtotalCell.value = document.totals.subtotal ?? 0;
    subtotalCell.numFmt = '#,##0.00';

    summarySheet.getCell('C16').value = 'Tax Total:';
    const taxCell = summarySheet.getCell('D16');
    taxCell.value = document.totals.taxTotal ?? 0;
    taxCell.numFmt = '#,##0.00';

    summarySheet.getCell('A17').value = 'Discount Total:';
    const discountCell = summarySheet.getCell('B17');
    discountCell.value = document.totals.discountTotal ?? 0;
    discountCell.numFmt = '#,##0.00';

    summarySheet.getCell('C17').value = 'Shipping/Handling:';
    const shippingCell = summarySheet.getCell('D17');
    shippingCell.value = document.totals.shippingCharges ?? 0;
    shippingCell.numFmt = '#,##0.00';

    summarySheet.getCell('A18').value = 'GRAND TOTAL:';
    summarySheet.getCell('A18').font = { bold: true, size: 12 };
    const grandTotalCell = summarySheet.getCell('B18');
    grandTotalCell.value = document.totals.grandTotal;
    grandTotalCell.font = { bold: true, size: 12, color: { argb: 'FF0F766E' } };
    grandTotalCell.numFmt = '#,##0.00';

    summarySheet.getCell('C18').value = 'Balance Due:';
    summarySheet.getCell('C18').font = { bold: true };
    const balanceCell = summarySheet.getCell('D18');
    balanceCell.value = document.totals.balanceDue ?? document.totals.grandTotal;
    balanceCell.font = { bold: true };
    balanceCell.numFmt = '#,##0.00';

    // Payment Section (Sanitized against Formula Injection)
    summarySheet.mergeCells('A20:D20');
    const payHeader = summarySheet.getCell('A20');
    payHeader.value = 'PAYMENT DETAILS';
    payHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    payHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };

    summarySheet.getCell('A21').value = 'Payment Terms:';
    summarySheet.getCell('B21').value = sanitizeSpreadsheetText(document.payment?.paymentTerms, 'Standard');
    summarySheet.getCell('C21').value = 'Payment Reference:';
    summarySheet.getCell('D21').value = sanitizeSpreadsheetText(document.payment?.paymentReference);

    summarySheet.getCell('A22').value = 'Bank Name:';
    summarySheet.getCell('B22').value = sanitizeSpreadsheetText(document.payment?.bankDetails?.bankName);
    summarySheet.getCell('C22').value = 'IBAN / Account:';
    summarySheet.getCell('D22').value = sanitizeSpreadsheetText(
      document.payment?.bankDetails?.iban || document.payment?.bankDetails?.accountNumber
    );

    // Add labels styling for keys
    ['A3', 'C3', 'A4', 'C4', 'A5', 'C5', 'A6', 'C6', 'A9', 'A10', 'A11', 'A12', 'A13', 'C9', 'C10', 'C11', 'C12', 'C13', 'A16', 'C16', 'A17', 'C17', 'A21', 'C21', 'A22', 'C22'].forEach(cellPos => {
      summarySheet.getCell(cellPos).font = { bold: true, color: { argb: 'FF64748B' } };
    });

    // ==========================================
    // SHEET 2: Line Items
    // ==========================================
    const lineSheet = workbook.addWorksheet('Line Items', {
      views: [{ showGridLines: true }],
    });

    lineSheet.columns = [
      { header: '#', key: 'line', width: 6 },
      { header: 'Description', key: 'description', width: 42 },
      { header: 'SKU / Code', key: 'sku', width: 16 },
      { header: 'Qty', key: 'qty', width: 10 },
      { header: 'Unit', key: 'unit', width: 10 },
      { header: 'Unit Price', key: 'unitPrice', width: 15 },
      { header: 'Discount', key: 'discount', width: 12 },
      { header: 'Tax %', key: 'taxRate', width: 12 },
      { header: 'Calculated Line Total', key: 'calcTotal', width: 22 },
      { header: 'Extracted Line Total', key: 'extTotal', width: 22 },
    ];

    // Style Header Row
    const headerRow = lineSheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    let currentRow = 2;
    document.lineItems.forEach((item, index) => {
      const row = lineSheet.getRow(currentRow);
      const lineNum = item.lineNumber || index + 1;
      const rowIdx = currentRow;

      row.getCell('line').value = lineNum;
      // Formula Injection Sanitization on item description, SKU, and unit
      row.getCell('description').value = sanitizeSpreadsheetText(item.description, '');
      row.getCell('sku').value = sanitizeSpreadsheetText(item.sku, '');
      row.getCell('qty').value = item.quantity;
      row.getCell('qty').numFmt = '#,##0.00';
      row.getCell('unit').value = sanitizeSpreadsheetText(item.unit, 'ea');
      row.getCell('unitPrice').value = item.unitPrice;
      row.getCell('unitPrice').numFmt = '#,##0.00';
      row.getCell('discount').value = item.discount || 0;
      row.getCell('discount').numFmt = '#,##0.00';
      row.getCell('taxRate').value = item.taxRate ? `${(item.taxRate * 100).toFixed(1)}%` : '0%';

      // Excel formula for line total: (Qty * UnitPrice) - Discount
      row.getCell('calcTotal').value = {
        formula: `(D${rowIdx}*F${rowIdx})-G${rowIdx}`,
        result: (item.quantity * item.unitPrice) - (item.discount || 0),
      };
      row.getCell('calcTotal').numFmt = '#,##0.00';

      row.getCell('extTotal').value = item.lineTotal;
      row.getCell('extTotal').numFmt = '#,##0.00';

      // Alternate row backgrounds for readability
      if (currentRow % 2 === 0) {
        row.eachCell(cell => {
          if (!cell.fill || cell.fill.type !== 'pattern') {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFF8FAFC' },
            };
          }
        });
      }

      currentRow++;
    });

    // Totals row at the bottom of Line Items
    if (document.lineItems.length > 0) {
      const totalsRow = lineSheet.getRow(currentRow);
      totalsRow.getCell('description').value = 'TOTAL';
      totalsRow.getCell('description').font = { bold: true };
      totalsRow.getCell('calcTotal').value = {
        formula: `SUM(I2:I${currentRow - 1})`,
        result: document.totals.subtotal ?? 0,
      };
      totalsRow.getCell('calcTotal').numFmt = '#,##0.00';
      totalsRow.getCell('calcTotal').font = { bold: true };

      totalsRow.getCell('extTotal').value = {
        formula: `SUM(J2:J${currentRow - 1})`,
        result: document.totals.subtotal ?? 0,
      };
      totalsRow.getCell('extTotal').numFmt = '#,##0.00';
      totalsRow.getCell('extTotal').font = { bold: true };
    }

    // ==========================================
    // SHEET 3: Reconciliation & Audit Trail
    // ==========================================
    if (options.includeAuditSheet) {
      const auditSheet = workbook.addWorksheet('Reconciliation & Audit', {
        views: [{ showGridLines: true }],
      });

      auditSheet.columns = [
        { header: 'Audit Item', key: 'item', width: 35 },
        { header: 'Extracted Value', key: 'ext', width: 22 },
        { header: 'Calculated Value', key: 'calc', width: 22 },
        { header: 'Variance', key: 'var', width: 16 },
        { header: 'Status', key: 'status', width: 22 },
      ];

      const auditHeader = auditSheet.getRow(1);
      auditHeader.height = 28;
      auditHeader.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });

      const auditRows = [
        {
          item: 'Overall Verification State',
          ext: reconciliation.overallStatus,
          calc: reconciliation.isVerified ? 'VERIFIED' : 'UNVERIFIED',
          var: '0.00',
          status: reconciliation.isVerified ? 'PASSED' : 'FLAGGED',
        },
        {
          item: 'Subtotal Verification',
          ext: (reconciliation.totals.extractedSubtotal ?? 0).toFixed(2),
          calc: reconciliation.totals.calculatedSubtotal.toFixed(2),
          var: reconciliation.totals.subtotalVariance.toFixed(2),
          status: reconciliation.totals.subtotalVariance <= reconciliation.toleranceApplied ? 'PASSED' : 'DISCREPANCY',
        },
        {
          item: 'Tax Total Verification',
          ext: (reconciliation.totals.extractedTaxTotal ?? 0).toFixed(2),
          calc: reconciliation.totals.calculatedTaxTotal.toFixed(2),
          var: reconciliation.totals.taxVariance.toFixed(2),
          status: reconciliation.totals.taxVariance <= reconciliation.toleranceApplied ? 'PASSED' : 'DISCREPANCY',
        },
        {
          item: 'Grand Total Reconciliation',
          ext: reconciliation.totals.extractedGrandTotal.toFixed(2),
          calc: reconciliation.totals.calculatedGrandTotal.toFixed(2),
          var: reconciliation.totals.grandTotalVariance.toFixed(2),
          status: reconciliation.totals.grandTotalVariance <= reconciliation.toleranceApplied ? 'PASSED' : 'DISCREPANCY',
        },
        {
          item: 'Page Coverage Completeness',
          ext: `${(document.coverage.extractionCompleteness * 100).toFixed(1)}%`,
          calc: `${document.coverage.processedPages}/${document.coverage.totalPages} pages`,
          var: '0.00',
          status: document.coverage.isFullyCovered ? 'FULL COVERAGE' : 'PARTIAL COVERAGE',
        },
      ];

      auditRows.forEach((r, idx) => {
        const row = auditSheet.getRow(idx + 2);
        row.getCell('item').value = sanitizeSpreadsheetText(r.item);
        row.getCell('ext').value = sanitizeSpreadsheetText(r.ext);
        row.getCell('calc').value = sanitizeSpreadsheetText(r.calc);
        row.getCell('var').value = sanitizeSpreadsheetText(r.var);
        row.getCell('status').value = sanitizeSpreadsheetText(r.status);
        row.getCell('status').font = {
          bold: true,
          color: { argb: r.status === 'PASSED' || r.status === 'FULL COVERAGE' ? 'FF16A34A' : 'FFDC2626' },
        };
      });
    }

    const uint8Array = await workbook.xlsx.writeBuffer();
    const finalBuffer = Buffer.from(uint8Array);

    if (finalBuffer.length > config.maxOutputSizeBytes) {
      throw new SpreadsheetGenerationError(
        `Generated Excel workbook (${(finalBuffer.length / (1024 * 1024)).toFixed(1)}MB) exceeds limit of ${(config.maxOutputSizeBytes / (1024 * 1024)).toFixed(1)}MB.`
      );
    }

    return finalBuffer;
  } catch (err: unknown) {
    if (err instanceof SpreadsheetGenerationError) {
      throw err;
    }
    throw new SpreadsheetGenerationError(
      `Failed to generate Excel workbook: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
