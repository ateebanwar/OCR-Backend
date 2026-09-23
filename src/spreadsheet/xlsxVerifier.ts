import ExcelJS from 'exceljs';
import { SpreadsheetGenerationError } from '../errors/AppError';

export interface WorksheetVerificationInfo {
  name: string;
  rowCount: number;
  columnCount: number;
  formulaCount: number;
  isValid: boolean;
}

export interface XlsxVerificationReport {
  isValid: boolean;
  sheetCount: number;
  sheetNames: string[];
  totalRows: number;
  totalColumns: number;
  formulaCount: number;
  errors: string[];
  sheets: WorksheetVerificationInfo[];
}

export async function verifyXlsxBuffer(buffer: Buffer): Promise<XlsxVerificationReport> {
  const errors: string[] = [];
  let totalRows = 0;
  let formulaCount = 0;
  let maxColumns = 0;
  const sheetNames: string[] = [];
  const sheets: WorksheetVerificationInfo[] = [];

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    workbook.eachSheet(sheet => {
      sheetNames.push(sheet.name);
      totalRows += sheet.rowCount;

      let sheetFormulas = 0;
      sheet.eachRow(row => {
        row.eachCell(cell => {
          if (cell.type === ExcelJS.ValueType.Formula) {
            sheetFormulas++;
            formulaCount++;
          }
        });
      });

      const colCount = sheet.columnCount;
      if (colCount > maxColumns) {
        maxColumns = colCount;
      }

      sheets.push({
        name: sheet.name,
        rowCount: sheet.rowCount,
        columnCount: colCount,
        formulaCount: sheetFormulas,
        isValid: sheet.rowCount > 0,
      });
    });

    // Integrity checks
    if (!sheetNames.includes('Document Summary')) {
      errors.push("Missing required sheet 'Document Summary'");
    }

    if (!sheetNames.includes('Line Items')) {
      errors.push("Missing required sheet 'Line Items'");
    }

    if (totalRows < 5) {
      errors.push(`Workbook appears truncated or empty; only found ${totalRows} total rows.`);
    }

    const isValid = errors.length === 0;

    return {
      isValid,
      sheetCount: sheetNames.length,
      sheetNames,
      totalRows,
      totalColumns: maxColumns,
      formulaCount,
      errors,
      sheets,
    };
  } catch (err: unknown) {
    throw new SpreadsheetGenerationError(
      `XLSX verification failed. The generated buffer could not be loaded as a valid Excel workbook: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
