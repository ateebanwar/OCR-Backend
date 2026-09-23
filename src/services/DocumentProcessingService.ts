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
    };
  }
}
