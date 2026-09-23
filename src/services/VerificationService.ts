import { AIProvider } from '../providers/ai/AIProvider';
import { RawFinancialExtraction } from '../extraction/schemas/financialSchema';
import { getSecondPassVerificationPrompt } from '../extraction/promptTemplates';
import { AppConfig } from '../config/env';
import { getVerificationModel } from '../config/models';
import { ModelInvocationTracker } from '../domain/telemetry';

export interface SecondPassVerificationResult {
  isVerified: boolean;
  confidenceScore: number;
  issuesFound: string[];
  correctionsNeeded: string[];
  verifierNotes: string;
}

export class VerificationService {
  private aiProvider: AIProvider;
  private config: AppConfig;

  constructor(aiProvider: AIProvider, config: AppConfig) {
    this.aiProvider = aiProvider;
    this.config = config;
  }

  public async verifyExtraction(
    pdfBuffer: Buffer,
    filename: string,
    extractedData: RawFinancialExtraction,
    tracker?: ModelInvocationTracker
  ): Promise<SecondPassVerificationResult> {
    const prompt = getSecondPassVerificationPrompt(extractedData);
    const verificationModel =
      (this.config.gemini?.verificationModel && this.config.gemini.verificationModel.trim()) ||
      getVerificationModel();

    const onInvocation = tracker
      ? (record: Parameters<ModelInvocationTracker['record']>[0]) => tracker.record(record)
      : undefined;

    try {
      const result = await this.aiProvider.extractStructuredData<{
        isVerified?: boolean;
        confidenceScore?: number;
        issuesFound?: string[];
        correctionsNeeded?: string[];
      }>(
        {
          buffer: pdfBuffer,
          mimeType: 'application/pdf',
          filename,
        },
        {
          systemPrompt:
            'You are an independent financial auditor. Verify data integrity against the source document with zero tolerance for discrepancies.',
          userPrompt: prompt,
        },
        {
          model: verificationModel,
          temperature: 0.0,
          purpose: 'VERIFICATION',
          onInvocation,
        }
      );

      const hasDiscrepancy = Boolean(result.issuesFound && result.issuesFound.length > 0);
      const isVerified = result.isVerified === true && !hasDiscrepancy;

      return {
        isVerified,
        confidenceScore: result.confidenceScore ?? (isVerified ? 1.0 : 0.5),
        issuesFound: result.issuesFound ?? [],
        correctionsNeeded: result.correctionsNeeded ?? [],
        verifierNotes: isVerified
          ? 'Second-pass audit completed successfully with no discrepancies.'
          : 'Second-pass audit flagged potential discrepancies between extracted data and source document.',
      };
    } catch {
      // If the second-pass audit call times out or fails, preserve unverified status safely
      return {
        isVerified: false,
        confidenceScore: 0.0,
        issuesFound: ['Second-pass audit verification was unable to complete due to provider timeout or error.'],
        correctionsNeeded: [],
        verifierNotes: 'Second-pass audit unverified due to provider timeout; deterministic reconciliation remains primary.',
      };
    }
  }
}
