import { AIProvider } from '../providers/ai/AIProvider';
import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';
import {
  getCorrectionPrompt,
  getExtractionSystemPrompt,
  getExtractionUserPrompt,
} from '../extraction/promptTemplates';
import { assertValidStructure, validateStructure } from '../validation/structuralValidator';
import { SemanticValidationResult, validateSemantics } from '../validation/semanticValidator';
import { reconcileFinancialDocument } from '../reconciliation/reconciliationEngine';
import { FinancialReconciliationReport, DocumentComplexityLevel } from '../domain/processing';
import { selectModelForComplexity, getEscalationModel } from '../config/models';
import { AppConfig } from '../config/env';
import { AppError, ConfigurationError, ExtractionError } from '../errors/AppError';
import { ModelInvocationTracker } from '../domain/telemetry';

export interface ExtractionResult {
  data: RawFinancialExtraction;
  reconciliation: FinancialReconciliationReport;
  semanticResult: SemanticValidationResult;
  retriesAttempted: number;
  escalationCount: number;
  escalationLevel: number; // Tier index (0: simple, 1: complex, 2: escalation)
  correctionCount: number;
  modelsUsed: string[];
  fallbackUsed: boolean;
  fallbackModel?: string;
}

export class ExtractionService {
  private aiProvider: AIProvider;
  private config: AppConfig;

  constructor(aiProvider: AIProvider, config: AppConfig) {
    this.aiProvider = aiProvider;
    this.config = config;
  }

  public async extractFinancialDocument(
    pdfBuffer: Buffer,
    filename: string,
    initialComplexity: DocumentComplexityLevel = 'LEVEL_1_SIMPLE',
    tracker?: ModelInvocationTracker
  ): Promise<ExtractionResult> {
    let currentModel = selectModelForComplexity(initialComplexity);
    if (!currentModel || !currentModel.trim()) {
      throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: GEMINI_EXTRACTION_MODEL is missing or invalid.');
    }

    // Tier index representation: 0 for Tier 1, 1 for Tier 2, 2 for Tier 3
    let currentTierIndex = initialComplexity === 'LEVEL_1_SIMPLE' ? 0 : (initialComplexity === 'LEVEL_2_COMPLEX' ? 1 : 2);
    
    // Escalation count strictly tracks runtime model tier transitions
    let escalationCount = 0;
    let retriesAttempted = 0;
    let correctionCount = 0;

    const rawModelsUsed: string[] = [currentModel];

    const docInput = {
      buffer: pdfBuffer,
      mimeType: 'application/pdf',
      filename,
    };

    const initialPromptContext = {
      systemPrompt: getExtractionSystemPrompt(),
      userPrompt: getExtractionUserPrompt(filename),
    };

    const onInvocation = tracker ? (record: Parameters<ModelInvocationTracker['record']>[0]) => tracker.record(record) : undefined;

    let rawExtraction: RawFinancialExtraction;
    try {
      const aiResponse = await this.aiProvider.extractStructuredData<unknown>(
        docInput,
        initialPromptContext,
        {
          model: currentModel,
          purpose: 'EXTRACTION',
          onInvocation,
        }
      );
      rawExtraction = assertValidStructure(aiResponse);
    } catch (err: unknown) {
      if (err instanceof AppError && (err.code === 'SERVER_CONFIGURATION_ERROR' || err.statusCode === 500)) {
        throw err;
      }
      if (this.config.maxExtractionRetries === 0) {
        if (err instanceof AppError) {
          throw err;
        }
        throw new ExtractionError(`Initial document extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Escalate tier if possible, otherwise retry on current model
      retriesAttempted++;
      if (currentTierIndex < 2) {
        currentTierIndex++;
        escalationCount++;
        currentModel = getEscalationModel(currentTierIndex);
        rawModelsUsed.push(currentModel);
      }

      try {
        const retryResponse = await this.aiProvider.extractStructuredData<unknown>(
          docInput,
          initialPromptContext,
          {
            model: currentModel,
            purpose: escalationCount > 0 ? 'ESCALATION' : 'RETRY',
            onInvocation,
          }
        );
        rawExtraction = assertValidStructure(retryResponse);
      } catch (retryErr: unknown) {
        if (retryErr instanceof AppError) {
          throw retryErr;
        }
        throw new ExtractionError(
          `Document extraction failed after escalation: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
        );
      }
    }

    // Initial validation and reconciliation
    let semanticResult = validateSemantics(rawExtraction);
    let reconciliationReport = reconcileFinancialDocument(rawExtraction);

    // AI Correction Loop: if reconciliation or semantic validation failed, retry with feedback
    while (
      (!reconciliationReport.isVerified || !semanticResult.isValid) &&
      correctionCount < this.config.maxExtractionRetries
    ) {
      correctionCount++;
      retriesAttempted++;

      // If persistent discrepancy exists and higher tier reasoning is available, escalate tier
      if (currentTierIndex < 2) {
        currentTierIndex++;
        escalationCount++;
        currentModel = getEscalationModel(currentTierIndex);
        rawModelsUsed.push(currentModel);
      }

      const allDiscrepancies = [
        ...reconciliationReport.discrepancies,
        ...semanticResult.errors,
      ];

      const correctionPrompt = getCorrectionPrompt(
        rawExtraction,
        allDiscrepancies,
        semanticResult.errors
      );

      try {
        const correctedAiResponse = await this.aiProvider.extractStructuredData<unknown>(
          docInput,
          {
            systemPrompt: getExtractionSystemPrompt(),
            userPrompt: correctionPrompt,
          },
          {
            model: currentModel,
            temperature: 0.0,
            purpose: 'CORRECTION',
            onInvocation,
          }
        );

        const structValidation = validateStructure(correctedAiResponse);
        if (structValidation.isValid && structValidation.data) {
          rawExtraction = structValidation.data;
          semanticResult = validateSemantics(rawExtraction);
          reconciliationReport = reconcileFinancialDocument(rawExtraction);
        }
      } catch {
        // If a correction attempt fails, retain current best extraction
        break;
      }
    }

    const fallbackInfo = tracker ? tracker.getFallbackInfo() : { fallbackUsed: false, fallbackModel: undefined };

    return {
      data: rawExtraction,
      reconciliation: reconciliationReport,
      semanticResult,
      retriesAttempted,
      escalationCount,
      escalationLevel: currentTierIndex,
      correctionCount,
      modelsUsed: Array.from(new Set(rawModelsUsed)),
      fallbackUsed: fallbackInfo.fallbackUsed,
      fallbackModel: fallbackInfo.fallbackModel,
    };
  }
}
