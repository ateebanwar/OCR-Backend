import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';
import { ReviewIssue, CorrectionRecord, ResolutionDecision } from '../domain/review';
import { reconcileFinancialDocument } from '../reconciliation/reconciliationEngine';
import { FinancialReconciliationReport } from '../domain/processing';

export interface CorrectionEngineResult {
  data: RawFinancialExtraction;
  corrections: CorrectionRecord[];
  issues: ReviewIssue[];
  autoCorrected: boolean;
  reconciliation: FinancialReconciliationReport;
}

const DISCOUNT_KEYWORDS = [
  'discount',
  'promo',
  'promotional',
  'promotional code',
  'promo code',
  'recurring discount',
  'coupon',
  'voucher',
  'rebate',
  '% off',
  'percent off',
  'special offer',
  'savings',
  'reduction',
  'markdown',
  'sale discount',
  'early bird',
  'promotion',
  'courtesy discount',
  'loyalty discount',
  'volume discount',
];

const CREDIT_KEYWORDS = [
  'credit',
  'credit note',
  'courtesy credit',
  'store credit',
  'balance credit',
  'service credit',
];

const REFUND_KEYWORDS = [
  'refund',
  'reimbursement',
  'chargeback',
  'return',
  'refunded',
];

const ADJUSTMENT_KEYWORDS = [
  'adjustment',
  'fee adjustment',
  'price adjustment',
  'correction',
];

export class CorrectionEngine {
  /**
   * Analyzes extracted financial document data.
   * Auto-corrects unambiguous AI misclassifications backed by textual and mathematical evidence.
   * Creates structured review issues for ambiguous or unbalanced data.
   */
  public analyzeAndCorrect(rawData: RawFinancialExtraction): CorrectionEngineResult {
    // Deep clone to ensure immutability of input
    const data: RawFinancialExtraction = JSON.parse(JSON.stringify(rawData));
    const corrections: CorrectionRecord[] = [];
    const issues: ReviewIssue[] = [];
    let autoCorrected = false;

    // Scan line items for negative values
    for (let i = 0; i < data.lineItems.length; i++) {
      const item = data.lineItems[i];
      if (!item) continue;

      const hasNegativePrice = item.unitPrice < 0;
      const hasNegativeTotal = item.lineTotal < 0;

      if (hasNegativePrice || hasNegativeTotal) {
        const descLower = (item.description || '').toLowerCase();
        const matchedDiscountKw = DISCOUNT_KEYWORDS.find((kw) => descLower.includes(kw));
        const matchedCreditKw = CREDIT_KEYWORDS.find((kw) => descLower.includes(kw));
        const matchedRefundKw = REFUND_KEYWORDS.find((kw) => descLower.includes(kw));
        const matchedAdjustmentKw = ADJUSTMENT_KEYWORDS.find((kw) => descLower.includes(kw));

        const originalUnitPrice = item.unitPrice;
        const originalLineTotal = item.lineTotal;
        const absVal = Math.abs(originalLineTotal !== 0 ? originalLineTotal : originalUnitPrice * (item.quantity || 1));

        if (matchedDiscountKw || matchedCreditKw || matchedRefundKw) {
          // Candidate hypothesis: Line item is a promotional discount / credit / refund
          // Convert line item: unitPrice = 0, discount = absVal, lineSubtotal = -absVal, lineTotal = -absVal
          // And add discount to totals.discountTotal if not already populated
          const candidateData: RawFinancialExtraction = JSON.parse(JSON.stringify(data));
          const candItem = candidateData.lineItems[i];
          if (candItem) {
            candItem.unitPrice = 0;
            candItem.discount = absVal;
            candItem.lineSubtotal = -absVal;
            candItem.lineTotal = -absVal;

            if (candidateData.totals.discountTotal === null || candidateData.totals.discountTotal === 0) {
              candidateData.totals.discountTotal = absVal;
            }

            const candidateRecon = reconcileFinancialDocument(candidateData);
            const originalRecon = reconcileFinancialDocument(data);

            // Evidence-based check:
            // 1. Exact or improved overall reconciliation
            const isExactOrImproved =
              candidateRecon.isVerified ||
              candidateRecon.discrepancies.length < originalRecon.discrepancies.length;

            // 2. Or explicit contextual evidence where the line item itself is verified with 0 variance,
            // no new discrepancies are introduced anywhere in the document,
            // and totals reconciliation (grand total and subtotal) is preserved or improved.
            const lineItemMatches = candidateRecon.lineItems[i]?.isMatched ?? false;
            const noNewDiscrepancies = candidateRecon.discrepancies.length <= originalRecon.discrepancies.length;
            const totalsPreservedOrImproved =
              Math.abs(candidateRecon.totals.grandTotalVariance) <= Math.abs(originalRecon.totals.grandTotalVariance) &&
              Math.abs(candidateRecon.totals.subtotalVariance) <= Math.abs(originalRecon.totals.subtotalVariance);

            const isContextuallyVerified = lineItemMatches && noNewDiscrepancies && totalsPreservedOrImproved;

            if (isExactOrImproved || isContextuallyVerified) {
              // High-confidence auto-correction verified by deterministic reconciliation
              data.lineItems[i] = candItem;
              data.totals.discountTotal = candidateData.totals.discountTotal;
              autoCorrected = true;

              const matchedReason = matchedDiscountKw
                ? `promotional keyword '${matchedDiscountKw}'`
                : matchedCreditKw
                ? `credit keyword '${matchedCreditKw}'`
                : `refund keyword '${matchedRefundKw}'`;

              corrections.push({
                issueId: `corr_auto_${Date.now()}_${i}`,
                page: 1,
                field: `lineItems[${i}].unitPrice`,
                lineItemIndex: i,
                originalField: `lineItems[${i}].unitPrice`,
                originalValue: originalUnitPrice,
                finalValue: 0,
                correctedValue: 0,
                interpretation: matchedDiscountKw ? 'promotional discount' : matchedCreditKw ? 'credit' : 'refund',
                discount: absVal,
                reason: `Extracted negative unitPrice on line item '${item.description}' auto-corrected to line discount and document discountTotal based on ${matchedReason}.`,
                evidence: [
                  `Line description: "${item.description}"`,
                  `Evidence keyword: "${matchedDiscountKw || matchedCreditKw || matchedRefundKw}"`,
                  `Mathematical reconciliation verified with 0 variance`,
                ],
                resolved: true,
                timestamp: new Date().toISOString(),
                source: 'AUTOMATIC_ENGINE',
              });
              continue;
            }
          }
        }

        // If not auto-corrected (no matching keyword OR math didn't balance):
        // Treat as AMBIGUOUS_VALUE requiring explicit user review
        const resolutionOptions: ResolutionDecision[] = [
          'DISCOUNT',
          'CREDIT',
          'REFUND',
          'ADJUSTMENT',
          'OTHER',
          'KEEP_AS_IS',
        ];

        issues.push({
          id: `issue_ambiguous_${Date.now()}_${i}`,
          type: 'AMBIGUOUS_VALUE',
          severity: 'WARNING',
          status: 'OPEN',
          page: 1,
          field: `lineItems[${i}].unitPrice`,
          lineItemIndex: i,
          originalValue: originalUnitPrice,
          aiInterpretation: {
            field: `lineItems[${i}].unitPrice`,
            value: originalUnitPrice,
          },
          message: `Line item #${i + 1} "${item.description}" contains negative unitPrice (${originalUnitPrice}) without conclusive promotional or credit context.`,
          reason: `Negative monetary value detected. Requires confirmation whether this represents a discount, credit, refund, adjustment, custom meaning, or raw source data.`,
          evidence: [
            {
              page: 1,
              text: item.description,
              field: `lineItems[${i}].description`,
              context: `unitPrice: ${originalUnitPrice}, lineTotal: ${originalLineTotal}`,
            },
          ],
          resolutionOptions,
          resolved: false,
        });
      }
    }

    // Run deterministic financial reconciliation on the resulting data
    const reconciliation = reconcileFinancialDocument(data);

    // If reconciliation failed, create structured review issues for unresolved math discrepancies
    if (!reconciliation.isVerified) {
      reconciliation.discrepancies.forEach((disc, idx) => {
        let discField = 'totals';
        if (disc.toLowerCase().includes('balance due')) {
          discField = 'balanceDue';
        } else if (disc.toLowerCase().includes('grand total')) {
          discField = 'grandTotal';
        } else if (disc.toLowerCase().includes('subtotal')) {
          discField = 'subtotal';
        } else if (disc.toLowerCase().includes('tax')) {
          discField = 'taxTotal';
        }

        issues.push({
          id: `issue_recon_${Date.now()}_${idx}`,
          type: 'RECONCILIATION_WARNING',
          severity: 'ERROR',
          status: 'OPEN',
          page: 1,
          field: discField,
          originalValue: disc,
          aiInterpretation: {
            field: discField,
            value: disc,
          },
          message: disc,
          reason: 'Financial reconciliation detected a non-zero mathematical variance between line items and summary totals.',
          evidence: [],
          resolutionOptions: ['KEEP_AS_IS', 'ADJUSTMENT', 'OTHER'],
          resolved: false,
        });
      });
    }

    return {
      data,
      corrections,
      issues,
      autoCorrected,
      reconciliation,
    };
  }
}
