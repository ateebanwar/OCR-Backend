import { describe, it, expect, beforeEach } from 'vitest';
import { ExtractionService } from '../../src/services/ExtractionService';
import { DocumentProcessingService } from '../../src/services/DocumentProcessingService';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { loadConfig } from '../../src/config/env';
import { GeminiProvider } from '../../src/providers/ai/GeminiProvider';
import { DocumentProcessingError, ExtractionError } from '../../src/errors/AppError';

describe('Fallback, Retry, Escalation, and AI Correction Loop Execution Paths', () => {
  let mockProvider: MockAIProvider;
  const config = loadConfig({
    NODE_ENV: 'test',
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'test-key',
    MAX_EXTRACTION_RETRIES: '2',
    MAX_ESCALATION_LEVELS: '2',
  });

  const samplePdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nstream\nBT /F1 12 Tf (Invoice 101) Tj ET\nendstream\n%%EOF'
  );

  beforeEach(() => {
    mockProvider = new MockAIProvider();
  });

  it('Scenario 1: Primary model succeeds and extraction is valid -> retryCount=0, escalationCount=0', async () => {
    const service = new ExtractionService(mockProvider, config);
    const result = await service.extractFinancialDocument(samplePdf, 'test.pdf', 'LEVEL_1_SIMPLE');

    expect(result.retriesAttempted).toBe(0);
    expect(result.escalationLevel).toBe(0);
    expect(result.correctionCount).toBe(0);
    expect(result.reconciliation.isVerified).toBe(true);
    expect(result.reconciliation.overallStatus).toBe('EXACT_MATCH');
  });

  it('Scenario 2: GeminiProvider candidate fallback chain contains fast resilience models', () => {
    const geminiProvider = new GeminiProvider(config);
    const chain = geminiProvider.buildCandidateFallbackChain('gemini-3.8-flash');

    expect(chain[0]).toBe('gemini-3.8-flash');
    expect(chain).toContain('gemini-3.6-flash');
    expect(chain).toContain('gemini-3.5-flash-lite');
    expect(chain).toContain('gemini-flash-lite-latest');
  });

  it('Scenario 3: GeminiProvider candidate fallback chain handles custom model and avoids duplicates', () => {
    const geminiProvider = new GeminiProvider(config);
    const chain = geminiProvider.buildCandidateFallbackChain('gemini-3.6-flash');

    expect(chain[0]).toBe('gemini-3.6-flash');
    // Ensure no duplicates
    const unique = Array.from(new Set(chain));
    expect(chain.length).toBe(unique.length);
    expect(chain).toContain('gemini-3.5-flash-lite');
  });

  it('Scenario 4: Malformed JSON output triggers escalation and retry with escalated model', async () => {
    let attempts = 0;
    mockProvider.customExtractHandler = (_doc, _prompt, options) => {
      attempts++;
      if (attempts === 1) {
        // Return malformed non-JSON data
        return 'INVALID_NON_JSON_CORRUPT_OUTPUT';
      }
      // Second attempt succeeds on escalated model
      expect(options?.model).toBe(config.gemini.complexExtractionModel);
      return mockProvider.mockExtractionData;
    };

    const service = new ExtractionService(mockProvider, config);
    const result = await service.extractFinancialDocument(samplePdf, 'test.pdf', 'LEVEL_1_SIMPLE');

    expect(attempts).toBe(2);
    expect(result.retriesAttempted).toBe(1);
    expect(result.escalationLevel).toBe(1);
    expect(result.modelsUsed.length).toBe(2);
    expect(result.reconciliation.isVerified).toBe(true);
  });

  it('Scenario 5: Schema validation failure triggers escalation and re-extraction', async () => {
    let attempts = 0;
    mockProvider.customExtractHandler = () => {
      attempts++;
      if (attempts === 1) {
        // Missing required lineItems and totals (schema invalid)
        return { documentType: 'invoice', invoiceNumber: 'INV-1' };
      }
      return mockProvider.mockExtractionData;
    };

    const service = new ExtractionService(mockProvider, config);
    const result = await service.extractFinancialDocument(samplePdf, 'test.pdf', 'LEVEL_1_SIMPLE');

    expect(attempts).toBe(2);
    expect(result.retriesAttempted).toBe(1);
    expect(result.escalationLevel).toBe(1);
    expect(result.reconciliation.isVerified).toBe(true);
  });

  it('Scenario 6: Reconciliation mismatch triggers AI correction loop with discrepancy feedback', async () => {
    let attempts = 0;
    let receivedCorrectionPrompt = false;

    mockProvider.customExtractHandler = (_doc, promptContext) => {
      attempts++;
      if (attempts === 1) {
        // Return mathematically conflicting totals (grandTotal 5000 vs calculated 3795)
        const flawedData = JSON.parse(JSON.stringify(mockProvider.mockExtractionData));
        flawedData.totals.grandTotal = 5000.0;
        return flawedData;
      }

      // Check that the correction prompt was passed to the model
      if (promptContext.userPrompt.includes('CRITICAL AUDIT CORRECTION REQUIRED')) {
        receivedCorrectionPrompt = true;
        expect(promptContext.userPrompt).toContain('Grand total discrepancy');
      }

      // Second attempt returns corrected matching data
      return mockProvider.mockExtractionData;
    };

    const service = new ExtractionService(mockProvider, config);
    const result = await service.extractFinancialDocument(samplePdf, 'test.pdf', 'LEVEL_1_SIMPLE');

    expect(attempts).toBe(2);
    expect(receivedCorrectionPrompt).toBe(true);
    expect(result.correctionCount).toBe(1);
    expect(result.retriesAttempted).toBe(1);
    expect(result.reconciliation.isVerified).toBe(true);
  });

  it('Scenario 7: Persistent financial mismatch exhausts retries, throws DocumentProcessingError, and stops XLSX generation', async () => {
    // Return persistently mismatched data
    mockProvider.customExtractHandler = () => {
      const flawedData = JSON.parse(JSON.stringify(mockProvider.mockExtractionData));
      flawedData.totals.grandTotal = 99999.0; // Persistent impossible discrepancy
      return flawedData;
    };

    const processingService = new DocumentProcessingService(mockProvider, config);

    await expect(processingService.processDocument(samplePdf, 'bad-invoice.pdf')).rejects.toThrow(
      DocumentProcessingError
    );
  });
});
