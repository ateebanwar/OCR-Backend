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
  private config: AppConfig;

  constructor(aiProvider: AIProvider, config: AppConfig) {
    this.config = config;
    this.extractionService = new ExtractionService(aiProvider, config);
    this.verificationService = new VerificationService(aiProvider, config);
  }

  public async processDocument(
    rawBuffer: Buffer,
    originalFilename: string
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

    // Coverage Tracking
    const estimatedPages = Math.max(
      complexity.estimatedPageCount,
      extractionResult.data.pageCount || 1
    );
    const coverageTracker = new CoverageTracker(estimatedPages);
    coverageTracker.markAllProcessed();
    const coverage = coverageTracker.getCoverage();

    // Completeness Check (Type and layout aware)
    const completeness = validateCompleteness(extractionResult.data, coverage);

    // Canonical Document Assembly
    const canonicalDoc: CanonicalFinancialDocument = {
      documentId: validatedFile.documentId,
      sourceFilename: validatedFile.originalFilename,
      documentHash,
      documentType: extractionResult.data.documentType,
      invoiceNumber: extractionResult.data.invoiceNumber,
      documentNumber: extractionResult.data.documentNumber,
      invoiceDate: extractionResult.data.invoiceDate,
      dueDate: extractionResult.data.dueDate,
      purchaseOrderNumber: extractionResult.data.purchaseOrderNumber,
      referenceNumbers: extractionResult.data.referenceNumbers,
      currency: extractionResult.data.currency,
      language: extractionResult.data.language,
      processingTimestamp: new Date().toISOString(),
      vendor: extractionResult.data.vendor,
      customer: extractionResult.data.customer,
      lineItems: extractionResult.data.lineItems,
      totals: extractionResult.data.totals,
      payment: extractionResult.data.payment,
      coverage,
    };

    // Stage 5: SECOND-PASS VERIFICATION
    stageStart = Date.now();
    const secondPass = await this.verificationService.verifyExtraction(
      validatedFile.buffer,
      validatedFile.originalFilename,
      extractionResult.data,
      invocationTracker
    );
    recordStage('VERIFYING_SECOND_PASS', stageStart);

    // Check for unresolvable financial discrepancies (Deterministic Reconciliation Authority)
    if (!extractionResult.reconciliation.isVerified) {
      recordStage('FAILED', stageStart);
      throw new DocumentProcessingError(
        `Financial reconciliation failed with unresolved discrepancies: ${extractionResult.reconciliation.discrepancies.join(
          '; '
        )}`,
        {
          documentId: validatedFile.documentId,
          reconciliation: extractionResult.reconciliation,
          discrepancies: extractionResult.reconciliation.discrepancies,
          auditNotes: extractionResult.reconciliation.auditNotes,
        }
      );
    }

    // Stage 6: GENERATING_XLSX
    stageStart = Date.now();
    const xlsxBuffer = await generateFinancialWorkbook(
      canonicalDoc,
      extractionResult.reconciliation,
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
      reconciliation: extractionResult.reconciliation,
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
    const correctionCount = extractionResult.correctionCount;
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

      overallReconciliationStatus: extractionResult.reconciliation.overallStatus,
      reconciliationVerificationStatus: extractionResult.reconciliation.isVerified,
      calculatedSubtotal: extractionResult.reconciliation.totals.calculatedSubtotal,
      extractedSubtotal: extractionResult.reconciliation.totals.extractedSubtotal,
      subtotalVariance: extractionResult.reconciliation.totals.subtotalVariance,
      calculatedTaxTotal: extractionResult.reconciliation.totals.calculatedTaxTotal,
      extractedTaxTotal: extractionResult.reconciliation.totals.extractedTaxTotal,
      taxVariance: extractionResult.reconciliation.totals.taxVariance,
      calculatedGrandTotal: extractionResult.reconciliation.totals.calculatedGrandTotal,
      extractedGrandTotal: extractionResult.reconciliation.totals.extractedGrandTotal,
      grandTotalVariance: extractionResult.reconciliation.totals.grandTotalVariance,
      calculatedBalanceDue: extractionResult.reconciliation.totals.calculatedBalanceDue,
      extractedBalanceDue: extractionResult.reconciliation.totals.extractedBalanceDue,
      balanceDueVariance: extractionResult.reconciliation.totals.balanceDueVariance,
      discrepancies: extractionResult.reconciliation.discrepancies,
      reconciliationConventions: extractionResult.reconciliation.conventions,
      toleranceApplied: extractionResult.reconciliation.toleranceApplied,
      currencyPrecision: extractionResult.reconciliation.currencyPrecision,
      sourceRoundingApplied: extractionResult.reconciliation.conventions?.sourceRoundingApplied ?? 0,
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
      discrepancies: extractionResult.reconciliation.discrepancies,
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
    };

    conversionSummarySchema.parse(summary);

    return {
      success: true,
      documentId: validatedFile.documentId,
      sourceFilename: validatedFile.originalFilename,
      documentHash,
      isVerified: gateResult.isVerified,
      document: canonicalDoc,
      reconciliation: extractionResult.reconciliation,
      auditTrail,
      xlsxBase64: xlsxBuffer.toString('base64'),
      xlsxVerification,
      summary,
    };
  }
}
