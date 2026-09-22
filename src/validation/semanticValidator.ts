import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';

export interface SemanticValidationResult {
  isValid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateSemantics(data: RawFinancialExtraction): SemanticValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Date Validation
  if (data.invoiceDate) {
    const invDate = new Date(data.invoiceDate);
    if (isNaN(invDate.getTime())) {
      warnings.push(`Invoice date '${data.invoiceDate}' is not a standard parseable ISO date format.`);
    } else {
      // Future date sanity check: not more than 2 years into the future
      const maxFuture = new Date();
      maxFuture.setFullYear(maxFuture.getFullYear() + 2);
      if (invDate > maxFuture) {
        warnings.push(`Invoice date '${data.invoiceDate}' is unusually far in the future.`);
      }

      if (data.dueDate) {
        const dueDate = new Date(data.dueDate);
        if (!isNaN(dueDate.getTime()) && dueDate < invDate) {
          warnings.push(`Due date '${data.dueDate}' is chronologically before invoice date '${data.invoiceDate}'.`);
        }
      }
    }
  }

  // 2. Line Items Sanity
  if (data.lineItems.length === 0) {
    warnings.push('Document contains 0 extracted line items.');
  } else {
    data.lineItems.forEach((item, idx) => {
      if (!isFinite(item.quantity) || item.quantity <= 0) {
        errors.push(`Line item #${idx + 1} has invalid quantity (${item.quantity}).`);
      }
      if (!isFinite(item.unitPrice)) {
        errors.push(`Line item #${idx + 1} has non-numeric unit price.`);
      }
      if (!isFinite(item.lineTotal)) {
        errors.push(`Line item #${idx + 1} has non-numeric line total.`);
      }
      if (item.taxRate !== null && (item.taxRate < 0 || item.taxRate > 1)) {
        warnings.push(`Line item #${idx + 1} tax rate (${item.taxRate}) is outside standard 0.0 - 1.0 range.`);
      }
    });
  }

  // 3. Totals Sanity
  if (!isFinite(data.totals.grandTotal)) {
    errors.push('Grand total must be a valid finite number.');
  }

  if (data.totals.grandTotal < 0 && data.documentType !== 'other') {
    warnings.push(`Document grand total is negative (${data.totals.grandTotal}), possibly a credit note.`);
  }

  // Currency code check
  const curr = data.currency.trim().toUpperCase();
  if (curr.length !== 3 && !['$', '€', '£', '¥', '₹'].includes(curr)) {
    warnings.push(`Currency '${data.currency}' is neither a 3-letter ISO code nor a standard currency symbol.`);
  }

  return {
    isValid: errors.length === 0,
    warnings,
    errors,
  };
}
