import { AppConfig } from '../config/env';
import { AIProvider } from '../providers/ai/AIProvider';
import { ExtractionService } from './ExtractionService';
import { VerificationService } from './VerificationService';
import { validatePdfBuffer } from '../security/fileValidator';
import { calculateDocumentHash } from '../documents/documentHasher';
import { analyzeDocumentComplexity } from '../documents/complexityAnalyzer';
import { CoverageTracker } from '../documents/coverageTracker';
import { validateCompleteness } from '../validation/completenessValidator';
import { generateFinancialWorkbook } from '../spreadsheet/xlsxGenerator';
import { verifyXlsxBuffer, XlsxVerificationReport } from '../spreadsheet/xlsxVerifier';
import { CanonicalFinancialDocument } from '../domain/financial';
import {
  FinancialReconciliationReport,
  ProcessingAuditTrail,
  ProcessingStage,
  StageDuration,
} from '../domain/processing';
import { DocumentProcessingError } from '../errors/AppError';
import { ModelInvocationTracker } from '../domain/telemetry';
import { evaluateFinalVerificationGate } from '../validation/verificationGate';
import {
  ConversionSummary,
  DocumentSummaryInfo,
  FinancialSummaryInfo,
  VerificationSummaryInfo,
  XlsxSummaryInfo,
  conversionSummarySchema,
} from '../domain/summary';
import { CorrectionEngine } from './CorrectionEngine';
import { DocumentStatusCalculator } from './DocumentStatusCalculator';
import { ReviewResolutionService } from './ReviewResolutionService';
import { ReviewIssue, CorrectionRecord, ReviewState } from '../domain/review';

export interface ProcessDocumentOptions {
  allowReviewRequired?: boolean;
}

export interface DocumentProcessingResult {
  success: boolean;
  documentId: string;
  sourceFilename: string;
  documentHash: string;
  isVerified: boolean;
  document: CanonicalFinancialDocument;
  reconciliation: FinancialReconciliationReport;
  auditTrail: ProcessingAuditTrail;
  xlsxBase64: string;
  xlsxVerification: XlsxVerificationReport;
  summary: ConversionSummary;
}

export class DocumentProcessingService {
  private extractionService: ExtractionService;
  private verificationService: VerificationService;
  private correctionEngine: CorrectionEngine;
  private reviewResolutionService: ReviewResolutionService;
  private config: AppConfig;

  constructor(aiProvider: AIProvider, config: AppConfig) {
    this.config = config;
    this.extractionService = new ExtractionService(aiProvider, config);
    this.verificationService = new VerificationService(aiProvider, config);
    this.correctionEngine = new CorrectionEngine();
    this.reviewResolutionService = new ReviewResolutionService();
  }

  public getReviewResolutionService(): ReviewResolutionService {
    return this.reviewResolutionService;
  }

  public async processDocument(
    rawBuffer: Buffer,
    originalFilename: string,
    options?: ProcessDocumentOptions
  ): Promise<DocumentProcessingResult> {
    const overallStartTime = Date.now();
    const stageDurations: StageDuration[] = [];
    const invocationTracker = new ModelInvocationTracker();

    const recordStage = (stage: ProcessingStage, startTime: number) => {
      stageDurations.push({
        stage,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
    };

    // Stage 1: VALIDATING_FILE
    let stageStart = Date.now();
    const validatedFile = validatePdfBuffer(
      rawBuffer,
      originalFilename,
      this.config.maxUploadSizeBytes,
      this.config.maxPdfPages
    );
    recordStage('VALIDATING_FILE', stageStart);

    // Stage 2: DOCUMENT_HASHED
    stageStart = Date.now();
    const documentHash = calculateDocumentHash(validatedFile.buffer);
    recordStage('DOCUMENT_HASHED', stageStart);

    // Stage 3: ANALYZING_COMPLEXITY
    stageStart = Date.now();
    const complexity = analyzeDocumentComplexity(validatedFile.buffer);
    recordStage('ANALYZING_COMPLEXITY', stageStart);

    // Stage 4: EXTRACTION & RECONCILIATION LOOP
    stageStart = Date.now();
    const extractionResult = await this.extractionService.extractFinancialDocument(
      validatedFile.buffer,
      validatedFile.originalFilename,
      complexity.level,
      invocationTracker
    );
    recordStage('EXTRACTING', stageStart);

    // Stage 4b: CORRECTION_ENGINE (Auto-correction & Issue Detection)
    const correctionResult = this.correctionEngine.analyzeAndCorrect(extractionResult.data);
    const finalData = correctionResult.data;
    const finalReconciliation = correctionResult.reconciliation;
    const corrections = correctionResult.corrections;
    const issues = correctionResult.issues;

    // Coverage Tracking
    const estimatedPages = Math.max(
      complexity.estimatedPageCount,
      finalData.pageCount || 1
    );
    const coverageTracker = new CoverageTracker(estimatedPages);
    coverageTracker.markAllProcessed();
    const coverage = coverageTracker.getCoverage();

    // Completeness Check (Type and layout aware)
    const completeness = validateCompleteness(finalData, coverage);

    // Canonical Document Assembly
    const canonicalDoc: CanonicalFinancialDocument = {
      documentId: validatedFile.documentId,
      sourceFilename: validatedFile.originalFilename,
      documentHash,
      documentType: finalData.documentType,
      invoiceNumber: finalData.invoiceNumber,
      documentNumber: finalData.documentNumber,
      invoiceDate: finalData.invoiceDate,
      dueDate: finalData.dueDate,
      purchaseOrderNumber: finalData.purchaseOrderNumber,
      referenceNumbers: finalData.referenceNumbers,
      currency: finalData.currency,
      language: finalData.language,
      processingTimestamp: new Date().toISOString(),
      vendor: finalData.vendor,
      customer: finalData.customer,
      lineItems: finalData.lineItems,
      totals: finalData.totals,
      payment: finalData.payment,
      coverage,
    };

    // Stage 5: SECOND-PASS VERIFICATION
    stageStart = Date.now();
    const secondPass = await this.verificationService.verifyExtraction(
      validatedFile.buffer,
      validatedFile.originalFilename,
      finalData,
      invocationTracker
    );
    recordStage('VERIFYING_SECOND_PASS', stageStart);

    const hasAmbiguousIssues = issues.some((i) => i.type === 'AMBIGUOUS_VALUE');

    // Check for unresolvable financial discrepancies (Deterministic Reconciliation Authority)
    // If math failed and there are NO ambiguous issues to review, fail immediately with DocumentProcessingError.
    if (!finalReconciliation.isVerified && !hasAmbiguousIssues && !options?.allowReviewRequired) {
      recordStage('FAILED', stageStart);
      throw new DocumentProcessingError(
        `Financial reconciliation failed with unresolved discrepancies: ${finalReconciliation.discrepancies.join(
          '; '
        )}`,
        {
          documentId: validatedFile.documentId,
          reconciliation: finalReconciliation,
          discrepancies: finalReconciliation.discrepancies,
          auditNotes: finalReconciliation.auditNotes,
        }
      );
    }

    // Stage 6: GENERATING_XLSX
    stageStart = Date.now();
    const xlsxBuffer = await generateFinancialWorkbook(
      canonicalDoc,
      finalReconciliation,
      { includeAuditSheet: true }
    );
    recordStage('GENERATING_XLSX', stageStart);

    // Stage 7: VERIFYING_XLSX
    stageStart = Date.now();
    const xlsxVerification = await verifyXlsxBuffer(xlsxBuffer);
    recordStage('VERIFYING_XLSX', stageStart);

    if (!xlsxVerification.isValid) {
      throw new DocumentProcessingError(
        `Generated Excel workbook failed integrity checks: ${xlsxVerification.errors.join('; ')}`
      );
    }

    recordStage('COMPLETED', stageStart);

    // Final Verification Gate: Strict multi-pillar aggregation AFTER XLSX verification
    const gateResult = evaluateFinalVerificationGate({
      reconciliation: finalReconciliation,
      secondPass,
      completeness,
      semanticValidation: extractionResult.semanticResult,
      xlsxVerification,
    });

    const verificationModel =
      (this.config.gemini?.verificationModel && this.config.gemini.verificationModel.trim()) ||
      'gemini-3.7-flash';

    // Model Telemetry from Invocation Tracker
    const telemetry = invocationTracker.getSummary();
    const modelsUsed = Array.from(
      new Set([...extractionResult.modelsUsed, ...telemetry.modelsUsed, verificationModel])
    );

    const retryCount = extractionResult.retriesAttempted;
    const escalationCount = extractionResult.escalationCount;
    const correctionCount = extractionResult.correctionCount + corrections.length;
    const fallbackUsed = telemetry.fallbackUsed || extractionResult.fallbackUsed;
    const fallbackModel = telemetry.fallbackModel || extractionResult.fallbackModel;

    const auditTrail: ProcessingAuditTrail = {
      stages: stageDurations,
      totalProcessingTimeMs: Date.now() - overallStartTime,
      complexityLevel: complexity.level,
      complexityScore: complexity.score,
      complexitySignals: complexity.signals as unknown as Record<string, unknown>,
      selectedModelTier: complexity.selectedTier,
      selectedModel: complexity.recommendedModel,
      verificationModel,
      fallbackUsed,
      fallbackModel,
      retryCount,
      escalationCount,
      correctionCount,
      modelsUsed,
      modelInvocations: telemetry.allInvocations,
      verificationGate: gateResult,
    };

    // Calculate Authoritative Document Status
    const documentStatus = DocumentStatusCalculator.calculateStatus({
      isVerified: gateResult.isVerified,
      reconciliationVerified: finalReconciliation.isVerified,
      issues,
      corrections,
    });

    const openIssues = issues.filter((i) => i.status === 'OPEN' && !i.resolved);
    const isReviewRequired = documentStatus === 'REVIEW_REQUIRED';

    let reviewToken: string | undefined;
    if (isReviewRequired) {
      reviewToken = this.reviewResolutionService.createReviewToken({
        documentId: validatedFile.documentId,
        documentHash,
        sourceFilename: validatedFile.originalFilename,
        canonicalDoc,
        issues,
        corrections,
        auditTrail,
      });
    }

    const reviewState: ReviewState = {
      required: isReviewRequired,
      openIssueCount: openIssues.length,
      reviewToken,
    };

    // Assemble Authoritative Post-Conversion Summaries for Frontend
    const documentSummary: DocumentSummaryInfo = {
      sourceFilename: validatedFile.originalFilename,
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

      overallReconciliationStatus: finalReconciliation.overallStatus,
      reconciliationVerificationStatus: finalReconciliation.isVerified,
      calculatedSubtotal: finalReconciliation.totals.calculatedSubtotal,
      extractedSubtotal: finalReconciliation.totals.extractedSubtotal,
      subtotalVariance: finalReconciliation.totals.subtotalVariance,
      calculatedTaxTotal: finalReconciliation.totals.calculatedTaxTotal,
      extractedTaxTotal: finalReconciliation.totals.extractedTaxTotal,
      taxVariance: finalReconciliation.totals.taxVariance,
      calculatedGrandTotal: finalReconciliation.totals.calculatedGrandTotal,
      extractedGrandTotal: finalReconciliation.totals.extractedGrandTotal,
      grandTotalVariance: finalReconciliation.totals.grandTotalVariance,
      calculatedBalanceDue: finalReconciliation.totals.calculatedBalanceDue,
      extractedBalanceDue: finalReconciliation.totals.extractedBalanceDue,
      balanceDueVariance: finalReconciliation.totals.balanceDueVariance,
      discrepancies: finalReconciliation.discrepancies,
      reconciliationConventions: finalReconciliation.conventions,
      toleranceApplied: finalReconciliation.toleranceApplied,
      currencyPrecision: finalReconciliation.currencyPrecision,
      sourceRoundingApplied: finalReconciliation.conventions?.sourceRoundingApplied ?? 0,
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
      discrepancies: finalReconciliation.discrepancies,
    };

    const baseName = validatedFile.originalFilename.replace(/\.[^/.]+$/, '').trim() || 'financial_document';
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

    conversionSummarySchema.parse(summary);

    return {
      success: true,
      documentId: validatedFile.documentId,
      sourceFilename: validatedFile.originalFilename,
      documentHash,
      isVerified: gateResult.isVerified,
      document: canonicalDoc,
      reconciliation: finalReconciliation,
      auditTrail,
      xlsxBase64: xlsxBuffer.toString('base64'),
      xlsxVerification,
      summary,
    };
  }
}
