import { DocumentCoverageMetadata } from '../domain/financial';
import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';

export interface CompletenessValidationResult {
  isComplete: boolean;
  coverage: DocumentCoverageMetadata;
  missingCrucialFields: string[];
  notes: string[];
}

/**
 * Validates document completeness based on coverage and crucial fields.
 * Layout and document-type aware: does not demand invoice-specific fields
 * on financial statements, reports, or accounting ledgers.
 */
export function validateCompleteness(
  data: RawFinancialExtraction,
  coverage: DocumentCoverageMetadata
): CompletenessValidationResult {
  const missingCrucialFields: string[] = [];
  const notes: string[] = [];

  // 1. Document Identity / Reference
  const hasIdentifier = Boolean(
    (data.invoiceNumber && data.invoiceNumber.trim().length > 0) ||
    (data.documentNumber && data.documentNumber.trim().length > 0) ||
    (data.referenceNumbers && data.referenceNumbers.length > 0)
  );
  if (!hasIdentifier) {
    missingCrucialFields.push('invoiceNumber / documentNumber');
  }

  // 2. Transacting Entity / Party
  const hasParty = Boolean(
    (data.vendor?.name && data.vendor.name.trim().length > 0) ||
    (data.customer?.name && data.customer.name.trim().length > 0)
  );
  if (!hasParty) {
    missingCrucialFields.push('vendor.name / customer.name');
  }

  // 3. Document Date (Type-Aware)
  const isInvoiceType = data.documentType === 'invoice' || data.documentType === 'bill';
  const hasDate = Boolean(
    data.invoiceDate ||
    data.dueDate ||
    data.payment?.dueDate
  );

  if (isInvoiceType && !hasDate) {
    missingCrucialFields.push('invoiceDate / dueDate');
  } else if (!hasDate) {
    notes.push(`Document type '${data.documentType}' does not specify a document-level date.`);
  }

  // 4. Financial Totals Validity
  if (
    data.totals === null ||
    data.totals === undefined ||
    !isFinite(data.totals.grandTotal)
  ) {
    missingCrucialFields.push('totals.grandTotal');
  }

  // 5. Coverage and Page Integrity
  if (coverage.failedPages && coverage.failedPages.length > 0) {
    notes.push(`Pages failed to process: ${coverage.failedPages.join(', ')}`);
  }

  if (coverage.skippedPages && coverage.skippedPages.length > 0) {
    notes.push(`Pages skipped during extraction: ${coverage.skippedPages.join(', ')}`);
  }

  if (coverage.extractionCompleteness < 1.0) {
    notes.push(`Extraction coverage is ${(coverage.extractionCompleteness * 100).toFixed(1)}%`);
  }

  const isComplete =
    coverage.isFullyCovered &&
    (!coverage.failedPages || coverage.failedPages.length === 0) &&
    coverage.extractionCompleteness >= 1.0 &&
    missingCrucialFields.length === 0;

  return {
    isComplete,
    coverage,
    missingCrucialFields,
    notes,
  };
}
