import { DocumentStatus, ReviewIssue, CorrectionRecord } from '../domain/review';

export interface StatusCalculationInput {
  isVerified: boolean;
  reconciliationVerified: boolean;
  issues: ReviewIssue[];
  corrections: CorrectionRecord[];
  isRejected?: boolean;
  rejectionReason?: string;
}

/**
 * Central authoritative calculator for canonical document statuses:
 * - VERIFIED: Everything balanced, verified, zero issues, zero corrections.
 * - VERIFIED_WITH_CORRECTIONS: Everything balanced and verified, but automatic or user corrections were applied.
 * - REVIEW_REQUIRED: Open issues exist, math reconciliation failed, or verification failed.
 * - REJECTED: Corrupted, unreadable, or invalid document.
 */
export class DocumentStatusCalculator {
  public static calculateStatus(input: StatusCalculationInput): DocumentStatus {
    if (input.isRejected) {
      return 'REJECTED';
    }

    const hasOpenIssues = input.issues.some(
      (issue) => issue.status === 'OPEN' && !issue.resolved
    );

    if (hasOpenIssues) {
      return 'REVIEW_REQUIRED';
    }

    // Deterministic reconciliation authority: Unbalanced math always requires review
    if (!input.reconciliationVerified) {
      return 'REVIEW_REQUIRED';
    }

    // Verification gate authority: XLSX, completeness, semantic checks must pass
    if (!input.isVerified) {
      return 'REVIEW_REQUIRED';
    }

    // If corrections were applied and everything now passes
    if (input.corrections && input.corrections.length > 0) {
      return 'VERIFIED_WITH_CORRECTIONS';
    }

    return 'VERIFIED';
  }
}
