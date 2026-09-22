import { Decimal } from './decimal';
import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';
import {
  FinancialReconciliationReport,
  LineItemReconciliation,
  ReconciliationStatus,
  TotalsReconciliation,
} from '../domain/processing';

export interface ReconciliationOptions {
  tolerance?: number; // Allowed rounding tolerance (default: 0.02)
}

export function reconcileFinancialDocument(
  data: RawFinancialExtraction,
  options: ReconciliationOptions = {}
): FinancialReconciliationReport {
  const tolerance = options.tolerance ?? 0.02;
  const discrepancies: string[] = [];
  const auditNotes: string[] = [];

  // --- Step 1: Reconcile Line Items ---
  const lineReconciliations: LineItemReconciliation[] = [];
  let calculatedGrossSubtotalDec = Decimal.from(0);
  let calculatedNetSubtotalDec = Decimal.from(0);
  let calculatedLineTaxesDec = Decimal.from(0);

  data.lineItems.forEach((item, index) => {
    const qtyDec = Decimal.from(item.quantity);
    const unitPriceDec = Decimal.from(item.unitPrice);
    const lineSubtotalCalc = qtyDec.multiply(unitPriceDec);

    let lineTotalCalc = lineSubtotalCalc;

    // Apply line discount if present
    if (item.discount !== null && item.discount !== undefined) {
      lineTotalCalc = lineTotalCalc.subtract(Decimal.from(item.discount));
    }

    // Apply line tax if present
    let lineTaxDec = Decimal.from(0);
    if (item.taxAmount !== null && item.taxAmount !== undefined) {
      lineTaxDec = Decimal.from(item.taxAmount);
      lineTotalCalc = lineTotalCalc.add(lineTaxDec);
    } else if (item.taxRate !== null && item.taxRate !== undefined && item.taxRate > 0) {
      lineTaxDec = lineSubtotalCalc.multiply(Decimal.from(item.taxRate));
      lineTotalCalc = lineTotalCalc.add(lineTaxDec);
    }

    calculatedGrossSubtotalDec = calculatedGrossSubtotalDec.add(lineSubtotalCalc);
    calculatedNetSubtotalDec = calculatedNetSubtotalDec.add(lineSubtotalCalc.subtract(Decimal.from(item.discount)));
    calculatedLineTaxesDec = calculatedLineTaxesDec.add(lineTaxDec);

    const extractedTotalDec = Decimal.from(item.lineTotal);
    const varianceDec = lineTotalCalc.subtract(extractedTotalDec).abs();
    const variance = varianceDec.toNumber();
    const isMatched = varianceDec.isWithinTolerance(0, tolerance);

    let notes: string | null = null;
    if (!isMatched) {
      notes = `Line #${index + 1} calculation (${qtyDec.toNumber()} x ${unitPriceDec.toNumber()} = ${lineTotalCalc.toFixed(2)}) differs from extracted total (${extractedTotalDec.toFixed(2)}) by ${variance.toFixed(2)}`;
      discrepancies.push(notes);
    }

    lineReconciliations.push({
      lineNumber: item.lineNumber || index + 1,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount,
      taxRate: item.taxRate,
      calculatedSubtotal: lineSubtotalCalc.toNumber(),
      calculatedTotal: lineTotalCalc.toNumber(),
      extractedTotal: item.lineTotal,
      variance,
      isMatched,
      notes,
    });
  });

  // --- Step 2: Reconcile Subtotal ---
  // In financial accounting, Subtotal can either be Gross (before discounts) or Net (after line discounts).
  const extractedSubtotal = data.totals.subtotal;
  let subtotalVariance = 0;
  let isSubtotalNet = false;
  let calculatedSubtotalDec = calculatedGrossSubtotalDec;

  if (extractedSubtotal !== null && extractedSubtotal !== undefined) {
    const extSubDec = Decimal.from(extractedSubtotal);
    const grossDiff = calculatedGrossSubtotalDec.subtract(extSubDec).abs();
    const netDiff = calculatedNetSubtotalDec.subtract(extSubDec).abs();

    if (netDiff.isWithinTolerance(0, tolerance)) {
      // Document provided Net Subtotal (discounts already deducted at line level)
      isSubtotalNet = true;
      calculatedSubtotalDec = calculatedNetSubtotalDec;
      subtotalVariance = netDiff.toNumber();
      auditNotes.push('Subtotal is recognized as Net Subtotal (line discounts already applied).');
    } else if (grossDiff.isWithinTolerance(0, tolerance)) {
      // Document provided Gross Subtotal
      isSubtotalNet = false;
      calculatedSubtotalDec = calculatedGrossSubtotalDec;
      subtotalVariance = grossDiff.toNumber();
      auditNotes.push('Subtotal is recognized as Gross Subtotal.');
    } else {
      // Neither matches
      calculatedSubtotalDec = calculatedGrossSubtotalDec;
      subtotalVariance = grossDiff.toNumber();
      if (data.lineItems.length > 0) {
        discrepancies.push(
          `Subtotal discrepancy: Calculated sum of line items (${calculatedGrossSubtotalDec.toFixed(2)} gross / ${calculatedNetSubtotalDec.toFixed(2)} net) differs from extracted subtotal (${extSubDec.toFixed(2)}) by ${subtotalVariance.toFixed(2)}`
        );
      }
    }
  } else if (data.lineItems.length > 0) {
    calculatedSubtotalDec = calculatedNetSubtotalDec;
    auditNotes.push('Subtotal was not explicitly provided in document; derived from sum of line items.');
  }

  // --- Step 3: Reconcile Taxes ---
  const extractedTax = data.totals.taxTotal;
  let calculatedTaxDec = calculatedLineTaxesDec;

  if (data.totals.taxesBreakdown && data.totals.taxesBreakdown.length > 0) {
    let breakdownTaxSum = Decimal.from(0);
    for (const tb of data.totals.taxesBreakdown) {
      breakdownTaxSum = breakdownTaxSum.add(Decimal.from(tb.amount));
    }
    calculatedTaxDec = breakdownTaxSum;
  }

  let taxVariance = 0;
  if (extractedTax !== null && extractedTax !== undefined) {
    const extTaxDec = Decimal.from(extractedTax);
    taxVariance = calculatedTaxDec.subtract(extTaxDec).abs().toNumber();
  }

  // --- Step 4: Reconcile Grand Total ---
  // Formula: If subtotal is already Net, do not deduct discountTotal again.
  const baseSubtotal =
    extractedSubtotal !== null && extractedSubtotal !== undefined
      ? Decimal.from(extractedSubtotal)
      : calculatedSubtotalDec;

  const discountDec = isSubtotalNet ? Decimal.from(0) : Decimal.from(data.totals.discountTotal);
  const taxDec =
    extractedTax !== null && extractedTax !== undefined
      ? Decimal.from(extractedTax)
      : calculatedTaxDec;
  const shippingDec = Decimal.from(data.totals.shippingCharges);
  const additionalDec = Decimal.from(data.totals.additionalCharges);
  const roundingDec = Decimal.from(data.totals.rounding);

  const calculatedGrandTotalDec = baseSubtotal
    .subtract(discountDec)
    .add(taxDec)
    .add(shippingDec)
    .add(additionalDec)
    .add(roundingDec);

  const extractedGrandTotalDec = Decimal.from(data.totals.grandTotal);
  const grandTotalVariance = calculatedGrandTotalDec.subtract(extractedGrandTotalDec).abs().toNumber();

  if (grandTotalVariance > tolerance) {
    discrepancies.push(
      `Grand total discrepancy: Calculated grand total (${calculatedGrandTotalDec.toFixed(2)}) differs from extracted grand total (${extractedGrandTotalDec.toFixed(2)}) by ${grandTotalVariance.toFixed(2)}`
    );
  }

  // --- Step 5: Reconcile Balance Due ---
  let calculatedBalanceDue: number | null = null;
  let balanceDueVariance: number | null = null;
  if (data.totals.paidAmount !== null && data.totals.paidAmount !== undefined) {
    const paidDec = Decimal.from(data.totals.paidAmount);
    const calcBalDec = extractedGrandTotalDec.subtract(paidDec);
    calculatedBalanceDue = calcBalDec.toNumber();

    if (data.totals.balanceDue !== null && data.totals.balanceDue !== undefined) {
      const extBalDec = Decimal.from(data.totals.balanceDue);
      balanceDueVariance = calcBalDec.subtract(extBalDec).abs().toNumber();
      if (balanceDueVariance > tolerance) {
        discrepancies.push(
          `Balance due discrepancy: Expected ${calcBalDec.toFixed(2)} (${extractedGrandTotalDec.toFixed(2)} - ${paidDec.toFixed(2)}), but found ${extBalDec.toFixed(2)}`
        );
      }
    }
  }

  // --- Step 6: Determine Overall Status ---
  let overallStatus: ReconciliationStatus = 'EXACT_MATCH';

  if (discrepancies.length === 0 && grandTotalVariance === 0 && subtotalVariance === 0) {
    overallStatus = 'EXACT_MATCH';
  } else if (
    discrepancies.length === 0 &&
    grandTotalVariance <= tolerance &&
    subtotalVariance <= tolerance
  ) {
    overallStatus = 'ACCEPTABLE_ROUNDING';
    auditNotes.push(`Variance is within configured rounding tolerance (+/-${tolerance}).`);
  } else if (data.totals.grandTotal === 0 && data.lineItems.length === 0) {
    overallStatus = 'MISSING_DATA';
  } else {
    overallStatus = 'DISCREPANCY';
  }

  const isVerified =
    overallStatus === 'EXACT_MATCH' || overallStatus === 'ACCEPTABLE_ROUNDING';

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
    toleranceApplied: tolerance,
    lineItems: lineReconciliations,
    totals: totalsRecon,
    discrepancies,
    auditNotes,
  };
}
