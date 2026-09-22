import { AIProvider } from '../providers/ai/AIProvider';
import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';
import {
  getCorrectionPrompt,
  getExtractionSystemPrompt,
  getExtractionUserPrompt,
} from '../extraction/promptTemplates';
import { assertValidStructure, validateStructure } from '../validation/structuralValidator';
import { validateSemantics } from '../validation/semanticValidator';
import { reconcileFinancialDocument } from '../reconciliation/reconciliationEngine';
import { FinancialReconciliationReport, DocumentComplexityLevel } from '../domain/processing';
import { selectModelForComplexity, getEscalationModel } from '../config/models';
import { AppConfig } from '../config/env';
import { AppError, ExtractionError } from '../errors/AppError';

export interface ExtractionResult {
  data: RawFinancialExtraction;
  reconciliation: FinancialReconciliationReport;
  retriesAttempted: number;
  escalationLevel: number;
  modelsUsed: string[];
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
    initialComplexity: DocumentComplexityLevel = 'LEVEL_1_SIMPLE'
  ): Promise<ExtractionResult> {
    const modelsUsed: string[] = [];
    let currentModel = selectModelForComplexity(initialComplexity);
    modelsUsed.push(currentModel);

    let retriesAttempted = 0;
    let escalationLevel = initialComplexity === 'LEVEL_1_SIMPLE' ? 0 : 1;

    const docInput = {
      buffer: pdfBuffer,
      mimeType: 'application/pdf',
      filename,
    };

    // First extraction pass
    const initialPromptContext = {
      systemPrompt: getExtractionSystemPrompt(),
      userPrompt: getExtractionUserPrompt(filename),
    };

    let rawExtraction: RawFinancialExtraction;
    try {
      const aiResponse = await this.aiProvider.extractStructuredData<unknown>(
        docInput,
        initialPromptContext,
        { model: currentModel }
      );
      rawExtraction = assertValidStructure(aiResponse);
    } catch (err: unknown) {
      if (this.config.maxExtractionRetries === 0) {
        if (err instanceof AppError) {
          throw err;
        }
        throw new ExtractionError(`Initial document extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Escalate and retry immediately
      escalationLevel++;
      currentModel = getEscalationModel(escalationLevel);
      modelsUsed.push(currentModel);
      retriesAttempted++;

      try {
        const retryResponse = await this.aiProvider.extractStructuredData<unknown>(
          docInput,
          initialPromptContext,
          { model: currentModel }
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
      retriesAttempted < this.config.maxExtractionRetries
    ) {
      retriesAttempted++;
      if (escalationLevel < this.config.maxEscalationLevels) {
        escalationLevel++;
        currentModel = getEscalationModel(escalationLevel);
        modelsUsed.push(currentModel);
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
          { model: currentModel, temperature: 0.0 }
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

    return {
      data: rawExtraction,
      reconciliation: reconciliationReport,
      retriesAttempted,
      escalationLevel,
      modelsUsed,
    };
  }
}
