import ExcelJS from 'exceljs';
import { SpreadsheetGenerationError } from '../errors/AppError';

export interface XlsxVerificationReport {
  isValid: boolean;
  sheetNames: string[];
  totalRows: number;
  formulaCount: number;
  errors: string[];
}

export async function verifyXlsxBuffer(buffer: Buffer): Promise<XlsxVerificationReport> {
  const errors: string[] = [];
  let totalRows = 0;
  let formulaCount = 0;
  const sheetNames: string[] = [];

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    workbook.eachSheet(sheet => {
      sheetNames.push(sheet.name);
      totalRows += sheet.rowCount;

      sheet.eachRow(row => {
        row.eachCell(cell => {
          if (cell.type === ExcelJS.ValueType.Formula) {
            formulaCount++;
          }
        });
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
      sheetNames,
      totalRows,
      formulaCount,
      errors,
    };
  } catch (err: unknown) {
    throw new SpreadsheetGenerationError(
      `XLSX verification failed. The generated buffer could not be loaded as a valid Excel workbook: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
