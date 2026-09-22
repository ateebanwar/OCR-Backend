import { DocumentCoverageMetadata } from '../domain/financial';
import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';

export interface CompletenessValidationResult {
  isComplete: boolean;
  coverage: DocumentCoverageMetadata;
  missingCrucialFields: string[];
  notes: string[];
}

export function validateCompleteness(
  data: RawFinancialExtraction,
  coverage: DocumentCoverageMetadata
): CompletenessValidationResult {
  const missingCrucialFields: string[] = [];
  const notes: string[] = [];

  if (!data.invoiceNumber && !data.documentNumber) {
    missingCrucialFields.push('invoiceNumber / documentNumber');
  }

  if (!data.vendor?.name) {
    missingCrucialFields.push('vendor.name');
  }

  if (!data.invoiceDate) {
    missingCrucialFields.push('invoiceDate');
  }

  if (coverage.failedPages.length > 0) {
    notes.push(`Pages failed to process: ${coverage.failedPages.join(', ')}`);
  }

  if (coverage.skippedPages.length > 0) {
    notes.push(`Pages skipped during extraction: ${coverage.skippedPages.join(', ')}`);
  }

  if (coverage.extractionCompleteness < 1.0) {
    notes.push(`Extraction coverage is ${(coverage.extractionCompleteness * 100).toFixed(1)}%`);
  }

  const isComplete =
    coverage.isFullyCovered &&
    missingCrucialFields.length === 0;

  return {
    isComplete,
    coverage,
    missingCrucialFields,
    notes,
  };
}
