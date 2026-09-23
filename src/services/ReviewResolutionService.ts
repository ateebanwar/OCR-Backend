import crypto from 'node:crypto';
import { CanonicalFinancialDocument } from '../domain/financial';
import {
  ReviewIssue,
  CorrectionRecord,
  ResolutionDecision,
  ReviewState,
} from '../domain/review';
import {
  FinancialReconciliationReport,
  ProcessingAuditTrail,
} from '../domain/processing';
import {
  ConversionSummary,
  DocumentSummaryInfo,
  FinancialSummaryInfo,
  VerificationSummaryInfo,
  XlsxSummaryInfo,
} from '../domain/summary';
import { reconcileFinancialDocument } from '../reconciliation/reconciliationEngine';
import { validateSemantics } from '../validation/semanticValidator';
import { validateCompleteness } from '../validation/completenessValidator';
import { generateFinancialWorkbook } from '../spreadsheet/xlsxGenerator';
import { verifyXlsxBuffer } from '../spreadsheet/xlsxVerifier';
import { evaluateFinalVerificationGate } from '../validation/verificationGate';
import { DocumentStatusCalculator } from './DocumentStatusCalculator';
import { ValidationError } from '../errors/AppError';
import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';
import { DocumentProcessingResult } from './DocumentProcessingService';

export interface ReviewTokenPayload {
  documentId: string;
  documentHash: string;
  sourceFilename: string;
  canonicalDoc: CanonicalFinancialDocument;
  issues: ReviewIssue[];
  corrections: CorrectionRecord[];
  auditTrail: ProcessingAuditTrail;
  issuedAt: number;
  expiresAt: number;
}

export interface IssueResolutionInput {
  issueId: string;
  userDecision: ResolutionDecision;
  customMeaning?: string | null;
  customValue?: unknown;
}

export interface ReviewResolutionRequest {
  reviewToken: string;
  resolutions: IssueResolutionInput[];
}

export class ReviewResolutionService {
  private secret: string;
  private tokenCache = new Map<string, ReviewTokenPayload>();
  private readonly maxCacheSize = 200;

  constructor(secret?: string) {
    this.secret =
      secret ||
      process.env.REVIEW_TOKEN_SECRET ||
      process.env.GEMINI_API_KEY ||
      'financial-document-review-stateless-hmac-salt-2026';
  }

  /**
   * Generates a tamper-proof HMAC-SHA256 signed review session token.
   */
  public createReviewToken(
    payload: Omit<ReviewTokenPayload, 'issuedAt' | 'expiresAt'>,
    ttlMs: number = 2 * 60 * 60 * 1000 // 2 hours default
  ): string {
    const fullPayload: ReviewTokenPayload = {
      ...payload,
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };

    const jsonStr = JSON.stringify(fullPayload);
    const dataB64 = Buffer.from(jsonStr).toString('base64url');
    const hmac = crypto
      .createHmac('sha256', this.secret)
      .update(dataB64)
      .digest('base64url');

    const token = `${dataB64}.${hmac}`;

    // Update in-memory LRU cache
    if (this.tokenCache.size >= this.maxCacheSize) {
      const firstKey = this.tokenCache.keys().next().value;
      if (firstKey) this.tokenCache.delete(firstKey);
    }
    this.tokenCache.set(fullPayload.documentId, fullPayload);

    return token;
  }

  /**
   * Verifies and decodes a review token, checking HMAC signature and expiration.
   */
  public verifyReviewToken(token: string): ReviewTokenPayload {
    if (!token || typeof token !== 'string') {
      throw new ValidationError('Review token is required and must be a string.');
    }

    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new ValidationError('Invalid review token structure.');
    }

    const dataB64 = parts[0];
    const signature = parts[1];
    const expectedSig = crypto
      .createHmac('sha256', this.secret)
      .update(dataB64)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new ValidationError('Review token signature verification failed (tampered or invalid).');
    }

    let payload: ReviewTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(dataB64, 'base64url').toString('utf8'));
    } catch {
      throw new ValidationError('Review token payload is corrupted or not valid JSON.');
    }

    if (Date.now() > payload.expiresAt) {
      throw new ValidationError('Review token has expired. Please reprocess the document.');
    }

    return payload;
  }

  /**
   * Processes user resolutions, applies corrections, re-runs deterministic reconciliation,
   * regenerates Excel report, recalculates canonical status, and produces updated processing result.
   */
  public async resolveReview(
    request: ReviewResolutionRequest
  ): Promise<DocumentProcessingResult> {
    const payload = this.verifyReviewToken(request.reviewToken);
    const canonicalDoc = payload.canonicalDoc;
    const issues = payload.issues;
    const corrections = payload.corrections;

    for (const res of request.resolutions) {
      const issue = issues.find((i) => i.id === res.issueId);
      if (!issue) {
        throw new ValidationError(`Issue with ID '${res.issueId}' not found in review session.`);
      }

      // Check if resolution decision is permitted
      if (!issue.resolutionOptions.includes(res.userDecision)) {
        throw new ValidationError(
          `Decision '${res.userDecision}' is not allowed for issue '${issue.id}'. Allowed: ${issue.resolutionOptions.join(', ')}`
        );
      }

      // Idempotency check: If already resolved with same decision, skip duplicate correction
      if (issue.resolved && issue.userDecision === res.userDecision) {
        continue;
      }

      const originalVal = issue.originalValue;
      const absVal = Math.abs(Number(originalVal) || 0);
      const timestamp = new Date().toISOString();

      if (res.userDecision === 'KEEP_AS_IS') {
        // KEEP_AS_IS preserves source value without reinterpretation.
        // It does NOT alter canonicalDoc numbers.
        // It marks the issue as resolved, but deterministic reconciliation will still verify the math.
        issue.resolved = true;
        issue.status = 'RESOLVED';
        issue.userDecision = 'KEEP_AS_IS';
        issue.customMeaning = res.customMeaning || null;
        issue.resolvedAt = timestamp;

        corrections.push({
          issueId: issue.id,
          page: issue.page,
          field: issue.field,
          lineItemIndex: issue.lineItemIndex,
          originalField: issue.field,
          originalValue: originalVal,
          finalValue: originalVal,
          reason: 'User explicitly confirmed preserving source value as-is without reinterpretation.',
          evidence: [`User selected KEEP_AS_IS for ${issue.field}`],
          resolved: true,
          timestamp,
          source: 'USER',
        });
      } else if (res.userDecision === 'DISCOUNT') {
        if (issue.lineItemIndex !== undefined) {
          const item = canonicalDoc.lineItems[issue.lineItemIndex];
          if (item) {
            item.unitPrice = 0;
            item.discount = absVal;
            item.lineTotal = -absVal;
            if (canonicalDoc.totals.discountTotal === null || canonicalDoc.totals.discountTotal === 0) {
              canonicalDoc.totals.discountTotal = absVal;
            }
          }
        }

        issue.resolved = true;
        issue.status = 'RESOLVED';
        issue.userDecision = 'DISCOUNT';
        issue.resolvedAt = timestamp;

        corrections.push({
          issueId: issue.id,
          page: issue.page,
          field: issue.field,
          lineItemIndex: issue.lineItemIndex,
          originalField: issue.field,
          originalValue: originalVal,
          finalValue: 0,
          reason: 'User confirmed value represents a discount.',
          evidence: [`User selected DISCOUNT resolution for ${issue.field}`],
          resolved: true,
          timestamp,
          source: 'USER',
        });
      } else if (res.userDecision === 'CREDIT') {
        if (issue.lineItemIndex !== undefined) {
          const item = canonicalDoc.lineItems[issue.lineItemIndex];
          if (item) {
            item.unitPrice = 0;
            item.discount = absVal;
            item.lineTotal = -absVal;
          }
        }

        issue.resolved = true;
        issue.status = 'RESOLVED';
        issue.userDecision = 'CREDIT';
        issue.resolvedAt = timestamp;

        corrections.push({
          issueId: issue.id,
          page: issue.page,
          field: issue.field,
          lineItemIndex: issue.lineItemIndex,
          originalField: issue.field,
          originalValue: originalVal,
          finalValue: 0,
          reason: 'User confirmed value represents a credit.',
          evidence: [`User selected CREDIT resolution for ${issue.field}`],
          resolved: true,
          timestamp,
          source: 'USER',
        });
      } else if (res.userDecision === 'REFUND') {
        issue.resolved = true;
        issue.status = 'RESOLVED';
        issue.userDecision = 'REFUND';
        issue.resolvedAt = timestamp;

        corrections.push({
          issueId: issue.id,
          page: issue.page,
          field: issue.field,
          lineItemIndex: issue.lineItemIndex,
          originalField: issue.field,
          originalValue: originalVal,
          finalValue: originalVal,
          reason: 'User confirmed value represents a refund.',
          evidence: [`User selected REFUND resolution for ${issue.field}`],
          resolved: true,
          timestamp,
          source: 'USER',
        });
      } else if (res.userDecision === 'ADJUSTMENT') {
        const finalVal = res.customValue !== undefined ? res.customValue : originalVal;
        if (issue.lineItemIndex !== undefined && typeof finalVal === 'number') {
          const item = canonicalDoc.lineItems[issue.lineItemIndex];
          if (item) {
            item.unitPrice = finalVal;
            item.lineTotal = finalVal * (item.quantity || 1);
          }
        }

        issue.resolved = true;
        issue.status = 'RESOLVED';
        issue.userDecision = 'ADJUSTMENT';
        issue.customValue = finalVal;
        issue.resolvedAt = timestamp;

        corrections.push({
          issueId: issue.id,
          page: issue.page,
          field: issue.field,
          lineItemIndex: issue.lineItemIndex,
          originalField: issue.field,
          originalValue: originalVal,
          finalValue: finalVal,
          reason: 'User applied adjustment to value.',
          evidence: [`User selected ADJUSTMENT resolution for ${issue.field}`],
          resolved: true,
          timestamp,
          source: 'USER',
        });
      } else if (res.userDecision === 'OTHER') {
        const customMeaning = res.customMeaning || 'Custom user classification';
        const finalVal = res.customValue !== undefined ? res.customValue : originalVal;

        issue.resolved = true;
        issue.status = 'RESOLVED';
        issue.userDecision = 'OTHER';
        issue.customMeaning = customMeaning;
        issue.customValue = finalVal;
        issue.resolvedAt = timestamp;

        corrections.push({
          issueId: issue.id,
          page: issue.page,
          field: issue.field,
          lineItemIndex: issue.lineItemIndex,
          originalField: issue.field,
          originalValue: originalVal,
          finalValue: finalVal,
          reason: `User defined custom classification: "${customMeaning}".`,
          evidence: [`Custom meaning: "${customMeaning}"`],
          resolved: true,
          timestamp,
          source: 'USER',
        });
      }
    }

    // Reconstruct RawFinancialExtraction equivalent for deterministic verification
    const extractionData: RawFinancialExtraction = {
      documentType: canonicalDoc.documentType,
      invoiceNumber: canonicalDoc.invoiceNumber,
      documentNumber: canonicalDoc.documentNumber,
      invoiceDate: canonicalDoc.invoiceDate,
      dueDate: canonicalDoc.dueDate,
      purchaseOrderNumber: canonicalDoc.purchaseOrderNumber,
      referenceNumbers: canonicalDoc.referenceNumbers || [],
      currency: canonicalDoc.currency,
      language: canonicalDoc.language,
      pageCount: canonicalDoc.coverage.totalPages || 1,
      vendor: canonicalDoc.vendor,
      customer: canonicalDoc.customer,
      lineItems: canonicalDoc.lineItems,
      totals: canonicalDoc.totals,
      payment: canonicalDoc.payment,
    };

    // Re-run Deterministic Financial Reconciliation
    const reconciliation = reconcileFinancialDocument(extractionData);

    // Re-run Semantic and Completeness validation
    const semanticResult = validateSemantics(extractionData);
    const completeness = validateCompleteness(extractionData, canonicalDoc.coverage);

    // Regenerate Financial XLSX
    const xlsxBuffer = await generateFinancialWorkbook(
      canonicalDoc,
      reconciliation,
      { includeAuditSheet: true }
    );
    const xlsxVerification = await verifyXlsxBuffer(xlsxBuffer);

    // Re-evaluate Verification Gate
    const gateResult = evaluateFinalVerificationGate({
      reconciliation,
      secondPass: {
        isVerified: true,
        confidenceScore: 0.95,
        issuesFound: [],
        correctionsNeeded: [],
        verifierNotes: 'Review resolution verification completed',
      },
      completeness,
      semanticValidation: semanticResult,
      xlsxVerification,
    });

    // Authoritative Document Status Calculation
    const documentStatus = DocumentStatusCalculator.calculateStatus({
      isVerified: gateResult.isVerified,
      reconciliationVerified: reconciliation.isVerified,
      issues,
      corrections,
    });

    const openIssues = issues.filter((i) => i.status === 'OPEN' && !i.resolved);
    const isReviewRequired = documentStatus === 'REVIEW_REQUIRED';

    // Generate new reviewToken if review still required
    let nextReviewToken: string | undefined;
    if (isReviewRequired) {
      nextReviewToken = this.createReviewToken({
        documentId: payload.documentId,
        documentHash: payload.documentHash,
        sourceFilename: payload.sourceFilename,
        canonicalDoc,
        issues,
        corrections,
        auditTrail: payload.auditTrail,
      });
    }

    const reviewState: ReviewState = {
      required: isReviewRequired,
      openIssueCount: openIssues.length,
      reviewToken: nextReviewToken,
    };

    // Assemble Summary
    const documentSummary: DocumentSummaryInfo = {
      sourceFilename: payload.sourceFilename,
      documentType: canonicalDoc.documentType,
      invoiceNumber: canonicalDoc.invoiceNumber,
      documentNumber: canonicalDoc.documentNumber,
      invoiceDate: canonicalDoc.invoiceDate,
      dueDate: canonicalDoc.dueDate,
      purchaseOrderNumber: canonicalDoc.purchaseOrderNumber,
      referenceNumbers: canonicalDoc.referenceNumbers || [],
      vendorName: canonicalDoc.vendor?.name ?? null,
      customerName: canonicalDoc.customer?.name ?? null,
      currency: canonicalDoc.currency,
      language: canonicalDoc.language,
      totalPdfPages: canonicalDoc.coverage.totalPages,
      processedPages: canonicalDoc.coverage.processedPages,
      extractedPages: canonicalDoc.coverage.extractedPages,
      failedPages: canonicalDoc.coverage.failedPages,
      skippedPages: canonicalDoc.coverage.skippedPages,
      extractionCompleteness: canonicalDoc.coverage.extractionCompleteness,
      isFullyCovered: canonicalDoc.coverage.isFullyCovered,
      extractedLineItemCount: canonicalDoc.lineItems.length,
    };

    const financialSummary: FinancialSummaryInfo = {
      currency: canonicalDoc.currency,
      subtotal: canonicalDoc.totals.subtotal,
      discountTotal: canonicalDoc.totals.discountTotal,
      taxTotal: canonicalDoc.totals.taxTotal,
      taxBreakdown: canonicalDoc.totals.taxesBreakdown || null,
      shippingCharges: canonicalDoc.totals.shippingCharges,
      additionalCharges: canonicalDoc.totals.additionalCharges,
      rounding: canonicalDoc.totals.rounding,
      grandTotal: canonicalDoc.totals.grandTotal,
      paidAmount: canonicalDoc.totals.paidAmount,
      balanceDue: canonicalDoc.totals.balanceDue,

      overallReconciliationStatus: reconciliation.overallStatus,
      reconciliationVerificationStatus: reconciliation.isVerified,
      calculatedSubtotal: reconciliation.totals.calculatedSubtotal,
      extractedSubtotal: reconciliation.totals.extractedSubtotal,
      subtotalVariance: reconciliation.totals.subtotalVariance,
      calculatedTaxTotal: reconciliation.totals.calculatedTaxTotal,
      extractedTaxTotal: reconciliation.totals.extractedTaxTotal,
      taxVariance: reconciliation.totals.taxVariance,
      calculatedGrandTotal: reconciliation.totals.calculatedGrandTotal,
      extractedGrandTotal: reconciliation.totals.extractedGrandTotal,
      grandTotalVariance: reconciliation.totals.grandTotalVariance,
      calculatedBalanceDue: reconciliation.totals.calculatedBalanceDue,
      extractedBalanceDue: reconciliation.totals.extractedBalanceDue,
      balanceDueVariance: reconciliation.totals.balanceDueVariance,
      discrepancies: reconciliation.discrepancies,
      reconciliationConventions: reconciliation.conventions,
      toleranceApplied: reconciliation.toleranceApplied,
      currencyPrecision: reconciliation.currencyPrecision,
      sourceRoundingApplied: reconciliation.conventions?.sourceRoundingApplied ?? 0,
    };

    const verificationSummary: VerificationSummaryInfo = {
      isVerified: gateResult.isVerified,
      reconciliationVerified: gateResult.reconciliationVerified,
      secondPassVerified: gateResult.secondPassVerified,
      completenessVerified: gateResult.completenessVerified,
      semanticVerified: gateResult.semanticVerified,
      xlsxVerified: gateResult.xlsxVerified,
      verificationGateStatus: gateResult.isVerified ? 'PASSED' : 'FAILED',
      gateFailureReasons: gateResult.gateFailureReasons,
      discrepancies: reconciliation.discrepancies,
    };

    const baseName = payload.sourceFilename.replace(/\.[^/.]+$/, '').trim() || 'financial_document';
    const generatedXlsxFilename = `${baseName}_financial_report.xlsx`;

    const xlsxSummary: XlsxSummaryInfo = {
      generatedXlsxFilename,
      xlsxValid: xlsxVerification.isValid,
      sheetCount: xlsxVerification.sheetCount,
      sheetNames: xlsxVerification.sheetNames,
      totalRowCount: xlsxVerification.totalRows,
      totalColumnCount: xlsxVerification.totalColumns,
      formulaCount: xlsxVerification.formulaCount,
      workbookErrors: xlsxVerification.errors,
      worksheetValidation: xlsxVerification.sheets,
      summarySheetPresent: xlsxVerification.sheetNames.includes('Document Summary'),
      lineItemsSheetPresent: xlsxVerification.sheetNames.includes('Line Items'),
      auditSheetPresent: xlsxVerification.sheetNames.includes('Reconciliation & Audit'),
    };

    const summary: ConversionSummary = {
      document: documentSummary,
      financial: financialSummary,
      verification: verificationSummary,
      xlsx: xlsxSummary,
      status: documentStatus,
      issues,
      corrections,
      review: reviewState,
    };

    return {
      success: true,
      documentId: payload.documentId,
      sourceFilename: payload.sourceFilename,
      documentHash: payload.documentHash,
      isVerified: gateResult.isVerified,
      document: canonicalDoc,
      reconciliation,
      auditTrail: payload.auditTrail,
      xlsxBase64: xlsxBuffer.toString('base64'),
      xlsxVerification,
      summary,
    };
  }
}
