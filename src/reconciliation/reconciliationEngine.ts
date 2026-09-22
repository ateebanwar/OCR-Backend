import { Decimal } from './decimal';
import { getCurrencyPrecision } from './currency';
import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';
import {
  CalculationConventions,
  FinancialReconciliationReport,
  LineItemReconciliation,
  ReconciliationStatus,
  TotalsReconciliation,
} from '../domain/processing';

export interface ReconciliationOptions {
  /**
   * Optional manual currency override if not present in extraction.
   */
  currency?: string;
}

/**
 * Deterministic Financial Reconciliation Engine
 *
 * Implements strict, high-precision decimal math with currency-specific precision.
 * Eliminates all blind/arbitrary tolerances (such as 0.02).
 * Reproduces legitimate issuer calculation conventions (Gross/Net subtotal, per-line/subtotal taxes, explicit rounding).
 */
export function reconcileFinancialDocument(
  data: RawFinancialExtraction,
  options: ReconciliationOptions = {}
): FinancialReconciliationReport {
  const discrepancies: string[] = [];
  const auditNotes: string[] = [];

  const currency = options.currency || data.currency || 'USD';
  const precision = getCurrencyPrecision(currency);

  let subtotalConvention: CalculationConventions['subtotalConvention'] = 'UNKNOWN';
  let taxConvention: CalculationConventions['taxConvention'] = 'UNKNOWN';

  // --- Step 1: Reconcile Line Items ---
  const lineReconciliations: LineItemReconciliation[] = [];
  let calculatedGrossSubtotalDec = Decimal.from(0);
  let calculatedNetSubtotalDec = Decimal.from(0);
  let calculatedLineTaxesDec = Decimal.from(0);
  let sumOfExtractedLineTotalsDec = Decimal.from(0);

  data.lineItems.forEach((item, index) => {
    const qtyDec = Decimal.from(item.quantity);
    const unitPriceDec = Decimal.from(item.unitPrice);
    const lineSubtotalRaw = qtyDec.multiply(unitPriceDec);
    const lineSubtotal = lineSubtotalRaw.roundTo(precision);

    // Apply line discount if specified
    let lineDiscountDec = Decimal.from(0);
    if (item.discount !== null && item.discount !== undefined) {
      lineDiscountDec = Decimal.from(item.discount).roundTo(precision);
    }
    const lineNetSubtotal = lineSubtotal.subtract(lineDiscountDec);

    // Calculate line tax if specified
    let lineTaxDec = Decimal.from(0);
    if (item.taxAmount !== null && item.taxAmount !== undefined) {
      lineTaxDec = Decimal.from(item.taxAmount).roundTo(precision);
    } else if (item.taxRate !== null && item.taxRate !== undefined && item.taxRate > 0) {
      // Convert tax rate (supports 0.10 or 10 for 10%)
      const rateDec = item.taxRate > 1 ? Decimal.from(item.taxRate).divide(100) : Decimal.from(item.taxRate);
      lineTaxDec = lineNetSubtotal.multiply(rateDec).roundTo(precision);
    }

    // Accumulate sums
    calculatedGrossSubtotalDec = calculatedGrossSubtotalDec.add(lineSubtotal);
    calculatedNetSubtotalDec = calculatedNetSubtotalDec.add(lineNetSubtotal);
    calculatedLineTaxesDec = calculatedLineTaxesDec.add(lineTaxDec);

    // Calculate both standard pricing conventions for this line:
    // A) Tax-exclusive: lineTotal = (quantity * unitPrice - discount) + tax
    const lineTotalTaxExcl = lineNetSubtotal.add(lineTaxDec).roundTo(precision);
    // B) Tax-inclusive: lineTotal = quantity * unitPrice - discount
    const lineTotalTaxIncl = lineNetSubtotal.roundTo(precision);

    const extractedTotalDec = Decimal.from(item.lineTotal).roundTo(precision);
    sumOfExtractedLineTotalsDec = sumOfExtractedLineTotalsDec.add(extractedTotalDec);

    let isMatched = false;
    let lineTotalCalc = lineTotalTaxExcl;
    let variance = 0;
    let notes: string | null = null;

    if (extractedTotalDec.equalsAtPrecision(lineTotalTaxExcl, precision)) {
      isMatched = true;
      lineTotalCalc = lineTotalTaxExcl;
      variance = 0;
    } else if (extractedTotalDec.equalsAtPrecision(lineTotalTaxIncl, precision)) {
      isMatched = true;
      lineTotalCalc = lineTotalTaxIncl;
      variance = 0;
      notes = 'Line total matches tax-inclusive pricing convention.';
    } else {
      isMatched = false;
      lineTotalCalc = lineTotalTaxExcl;
      const diffDec = extractedTotalDec.diff(lineTotalTaxExcl).roundTo(precision);
      variance = diffDec.toNumber();
      notes = `Line #${item.lineNumber || index + 1} calculation (${qtyDec.toFixed(precision)} x ${unitPriceDec.toFixed(precision)} = ${lineTotalTaxExcl.toFixed(precision)}) differs from extracted total (${extractedTotalDec.toFixed(precision)}) by ${variance.toFixed(precision)}`;
      discrepancies.push(notes);
    }

    lineReconciliations.push({
      lineNumber: item.lineNumber || index + 1,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount ?? null,
      taxRate: item.taxRate ?? null,
      calculatedSubtotal: lineSubtotal.toNumber(),
      calculatedTotal: lineTotalCalc.toNumber(),
      extractedTotal: item.lineTotal,
      variance,
      isMatched,
      notes,
    });
  });

  calculatedGrossSubtotalDec = calculatedGrossSubtotalDec.roundTo(precision);
  calculatedNetSubtotalDec = calculatedNetSubtotalDec.roundTo(precision);
  calculatedLineTaxesDec = calculatedLineTaxesDec.roundTo(precision);

  // --- Step 2: Reconcile Subtotal ---
  const extractedSubtotal = data.totals.subtotal;
  let subtotalVariance = 0;
  let calculatedSubtotalDec = calculatedGrossSubtotalDec;

  if (extractedSubtotal !== null && extractedSubtotal !== undefined) {
    const extSubDec = Decimal.from(extractedSubtotal).roundTo(precision);

    if (extSubDec.equalsAtPrecision(calculatedNetSubtotalDec, precision)) {
      subtotalConvention = 'NET';
      calculatedSubtotalDec = calculatedNetSubtotalDec;
      subtotalVariance = 0;
      auditNotes.push('Subtotal verified against Net Subtotal convention (line-item discounts already applied).');
    } else if (extSubDec.equalsAtPrecision(calculatedGrossSubtotalDec, precision)) {
      subtotalConvention = 'GROSS';
      calculatedSubtotalDec = calculatedGrossSubtotalDec;
      subtotalVariance = 0;
      auditNotes.push('Subtotal verified against Gross Subtotal convention.');
    } else {
      subtotalConvention = 'UNKNOWN';
      const grossDiff = extSubDec.diff(calculatedGrossSubtotalDec).roundTo(precision);
      const netDiff = extSubDec.diff(calculatedNetSubtotalDec).roundTo(precision);
      const minDiff = grossDiff.toNumber() <= netDiff.toNumber() ? grossDiff : netDiff;
      subtotalVariance = minDiff.toNumber();
      calculatedSubtotalDec = grossDiff.toNumber() <= netDiff.toNumber() ? calculatedGrossSubtotalDec : calculatedNetSubtotalDec;

      if (data.lineItems.length > 0) {
        discrepancies.push(
          `Subtotal discrepancy: Sum of line items (${calculatedGrossSubtotalDec.toFixed(precision)} gross / ${calculatedNetSubtotalDec.toFixed(precision)} net) differs from extracted subtotal (${extSubDec.toFixed(precision)}) by ${subtotalVariance.toFixed(precision)}`
        );
      }
    }
  } else if (data.lineItems.length > 0) {
    subtotalConvention = 'DERIVED';
    calculatedSubtotalDec = calculatedNetSubtotalDec;
    subtotalVariance = 0;
    auditNotes.push('Subtotal was not explicitly provided in document; deterministically derived from line items.');
  }

  // --- Step 3: Reconcile Tax Total ---
  const extractedTax = data.totals.taxTotal;
  let calculatedTaxDec = calculatedLineTaxesDec;
  let taxVariance = 0;

  // Breakdown check
  let breakdownTaxSum: Decimal | null = null;
  if (data.totals.taxesBreakdown && data.totals.taxesBreakdown.length > 0) {
    let sum = Decimal.from(0);
    for (const tb of data.totals.taxesBreakdown) {
      sum = sum.add(Decimal.from(tb.amount).roundTo(precision));
    }
    breakdownTaxSum = sum.roundTo(precision);
  }

  if (extractedTax !== null && extractedTax !== undefined) {
    const extTaxDec = Decimal.from(extractedTax).roundTo(precision);

    if (extTaxDec.equalsAtPrecision(calculatedLineTaxesDec, precision)) {
      taxConvention = 'PER_LINE';
      calculatedTaxDec = calculatedLineTaxesDec;
      taxVariance = 0;
      auditNotes.push('Tax verified against per-line item tax calculation convention.');
    } else if (breakdownTaxSum !== null && extTaxDec.equalsAtPrecision(breakdownTaxSum, precision)) {
      taxConvention = 'BREAKDOWN_SUM';
      calculatedTaxDec = breakdownTaxSum;
      taxVariance = 0;
      auditNotes.push('Tax verified against explicit tax breakdown schedule sum.');
    } else if (extTaxDec.isZero() && calculatedLineTaxesDec.isZero()) {
      taxConvention = 'ZERO_TAX';
      calculatedTaxDec = Decimal.from(0);
      taxVariance = 0;
      auditNotes.push('Zero-tax / tax-exempt document verified.');
    } else {
      taxConvention = 'UNKNOWN';
      calculatedTaxDec = breakdownTaxSum ?? calculatedLineTaxesDec;
      taxVariance = extTaxDec.diff(calculatedTaxDec).roundTo(precision).toNumber();
      discrepancies.push(
        `Tax total discrepancy: Calculated tax (${calculatedTaxDec.toFixed(precision)}) differs from extracted tax (${extTaxDec.toFixed(precision)}) by ${taxVariance.toFixed(precision)}`
      );
    }
  } else {
    calculatedTaxDec = calculatedLineTaxesDec;
    taxVariance = 0;
    taxConvention = calculatedLineTaxesDec.isZero() ? 'ZERO_TAX' : 'PER_LINE';
  }

  // --- Step 4: Reconcile Grand Total ---
  const baseSubtotal =
    extractedSubtotal !== null && extractedSubtotal !== undefined
      ? Decimal.from(extractedSubtotal).roundTo(precision)
      : calculatedSubtotalDec;

  // If subtotal was already Net, invoice-level discountTotal must not be deducted twice if it represents line discounts
  const discountTotalDec = Decimal.from(data.totals.discountTotal).roundTo(precision);
  const discountDec = subtotalConvention === 'NET' ? Decimal.from(0) : discountTotalDec;

  const taxDec =
    extractedTax !== null && extractedTax !== undefined
      ? Decimal.from(extractedTax).roundTo(precision)
      : calculatedTaxDec;

  const shippingDec = Decimal.from(data.totals.shippingCharges).roundTo(precision);
  const additionalDec = Decimal.from(data.totals.additionalCharges).roundTo(precision);
  const sourceRoundingDec = Decimal.from(data.totals.rounding).roundTo(precision);

  if (!sourceRoundingDec.isZero()) {
    auditNotes.push(`Source document includes explicit rounding adjustment of ${sourceRoundingDec.toFixed(precision)}`);
  }

  // Standard calculation: Subtotal - Discount + Tax + Shipping + Additional + Rounding
  const calcGrandTotalStandard = baseSubtotal
    .subtract(discountDec)
    .add(taxDec)
    .add(shippingDec)
    .add(additionalDec)
    .add(sourceRoundingDec)
    .roundTo(precision);

  // Sum of extracted line items formula (when line totals are net of line discounts)
  const calcGrandTotalLineSum = sumOfExtractedLineTotalsDec
    .add(taxDec)
    .add(shippingDec)
    .add(additionalDec)
    .add(sourceRoundingDec)
    .roundTo(precision);

  // Tax-inclusive pricing formula: Subtotal - Discount + Shipping + Additional + Rounding
  const calcGrandTotalTaxInclusive = baseSubtotal
    .subtract(discountDec)
    .add(shippingDec)
    .add(additionalDec)
    .add(sourceRoundingDec)
    .roundTo(precision);

  // Gross subtotal less explicit invoice discount formula
  const calcGrandTotalGrossLessDiscount = calculatedGrossSubtotalDec
    .subtract(discountTotalDec)
    .add(taxDec)
    .add(shippingDec)
    .add(additionalDec)
    .add(sourceRoundingDec)
    .roundTo(precision);

  const extractedGrandTotalDec = Decimal.from(data.totals.grandTotal).roundTo(precision);
  let calculatedGrandTotalDec = calcGrandTotalStandard;
  let grandTotalVariance = 0;

  if (extractedGrandTotalDec.equalsAtPrecision(calcGrandTotalStandard, precision)) {
    calculatedGrandTotalDec = calcGrandTotalStandard;
    grandTotalVariance = 0;
  } else if (extractedGrandTotalDec.equalsAtPrecision(calcGrandTotalLineSum, precision)) {
    calculatedGrandTotalDec = calcGrandTotalLineSum;
    grandTotalVariance = 0;
    auditNotes.push('Grand total reconciles with sum of individual line items.');
  } else if (extractedGrandTotalDec.equalsAtPrecision(calcGrandTotalTaxInclusive, precision)) {
    calculatedGrandTotalDec = calcGrandTotalTaxInclusive;
    grandTotalVariance = 0;
    auditNotes.push('Grand total reconciles under tax-inclusive pricing convention.');
  } else if (extractedGrandTotalDec.equalsAtPrecision(calcGrandTotalGrossLessDiscount, precision)) {
    calculatedGrandTotalDec = calcGrandTotalGrossLessDiscount;
    grandTotalVariance = 0;
    auditNotes.push('Grand total reconciles with gross subtotal less explicit invoice discount.');
  } else {
    calculatedGrandTotalDec = calcGrandTotalStandard;
    const diff = extractedGrandTotalDec.diff(calcGrandTotalStandard).roundTo(precision);
    grandTotalVariance = diff.toNumber();
    discrepancies.push(
      `Grand total discrepancy: Calculated grand total (${calcGrandTotalStandard.toFixed(precision)}) differs from extracted grand total (${extractedGrandTotalDec.toFixed(precision)}) by ${grandTotalVariance.toFixed(precision)}`
    );
  }

  // --- Step 5: Reconcile Balance Due ---
  let calculatedBalanceDue: number | null = null;
  let balanceDueVariance: number | null = null;

  if (data.totals.paidAmount !== null && data.totals.paidAmount !== undefined) {
    const paidDec = Decimal.from(data.totals.paidAmount).roundTo(precision);
    const expectedBalDec = extractedGrandTotalDec.subtract(paidDec).roundTo(precision);
    calculatedBalanceDue = expectedBalDec.toNumber();

    if (data.totals.balanceDue !== null && data.totals.balanceDue !== undefined) {
      const extBalDec = Decimal.from(data.totals.balanceDue).roundTo(precision);
      if (extBalDec.equalsAtPrecision(expectedBalDec, precision)) {
        balanceDueVariance = 0;
      } else {
        const balDiff = extBalDec.diff(expectedBalDec).roundTo(precision);
        balanceDueVariance = balDiff.toNumber();
        discrepancies.push(
          `Balance due discrepancy: Expected ${expectedBalDec.toFixed(precision)} (${extractedGrandTotalDec.toFixed(precision)} - ${paidDec.toFixed(precision)}), but extracted balance due is ${extBalDec.toFixed(precision)} (variance: ${balanceDueVariance.toFixed(precision)})`
        );
      }
    }
  } else if (data.totals.balanceDue !== null && data.totals.balanceDue !== undefined) {
    // If no paid amount was specified, balance due should equal grand total
    const extBalDec = Decimal.from(data.totals.balanceDue).roundTo(precision);
    if (!extBalDec.equalsAtPrecision(extractedGrandTotalDec, precision)) {
      const balDiff = extBalDec.diff(extractedGrandTotalDec).roundTo(precision);
      balanceDueVariance = balDiff.toNumber();
      calculatedBalanceDue = extractedGrandTotalDec.toNumber();
      discrepancies.push(
        `Balance due discrepancy: Expected ${extractedGrandTotalDec.toFixed(precision)} (unpaid invoice), but extracted balance due is ${extBalDec.toFixed(precision)} (variance: ${balanceDueVariance.toFixed(precision)})`
      );
    }
  }

  // --- Step 6: Determine Overall Status & Deterministic Verification ---
  let overallStatus: ReconciliationStatus = 'EXACT_MATCH';

  if (discrepancies.length === 0 && grandTotalVariance === 0 && subtotalVariance === 0) {
    overallStatus = 'EXACT_MATCH';
  } else if (data.totals.grandTotal === 0 && data.lineItems.length === 0) {
    overallStatus = 'MISSING_DATA';
  } else {
    overallStatus = 'DISCREPANCY';
  }

  // Verification is strictly boolean and requires zero unexplained discrepancy
  const isVerified = overallStatus === 'EXACT_MATCH';

  const totalsRecon: TotalsReconciliation = {
    calculatedSubtotal: calculatedSubtotalDec.toNumber(),
    extractedSubtotal: extractedSubtotal ?? null,
    subtotalVariance,

    calculatedTaxTotal: calculatedTaxDec.toNumber(),
    extractedTaxTotal: extractedTax ?? null,
    taxVariance,

    calculatedGrandTotal: calculatedGrandTotalDec.toNumber(),
    extractedGrandTotal: data.totals.grandTotal,
    grandTotalVariance,

    calculatedBalanceDue,
    extractedBalanceDue: data.totals.balanceDue ?? null,
    balanceDueVariance,

    status: overallStatus,
    discrepancies,
    isVerified,
  };

  return {
    documentId: 'pending',
    reconciledAt: new Date().toISOString(),
    overallStatus,
    isVerified,
    toleranceApplied: 0.0, // Strictly 0.0 (Zero arbitrary tolerance policy)
    currency,
    currencyPrecision: precision,
    conventions: {
      subtotalConvention,
      taxConvention,
      sourceRoundingApplied: sourceRoundingDec.toNumber(),
    },
    lineItems: lineReconciliations,
    totals: totalsRecon,
    discrepancies,
    auditNotes,
  };
}
