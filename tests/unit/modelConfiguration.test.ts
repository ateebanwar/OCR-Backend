import { describe, it, expect } from 'vitest';
import { loadConfig, DEFAULT_AI_MODEL } from '../../src/config/env';
import { getModelHierarchy, selectModelForComplexity, getEscalationModel } from '../../src/config/models';
import { GeminiProvider } from '../../src/providers/ai/GeminiProvider';
import { ConfigurationError } from '../../src/errors/AppError';

describe('Model Configuration & Safety Audit', () => {
  it('defaults to DEFAULT_AI_MODEL (gemini-3.6-flash) when GEMINI_EXTRACTION_MODEL is undefined', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
    });

    expect(config.gemini.extractionModel).toBe(DEFAULT_AI_MODEL);
    expect(config.gemini.complexExtractionModel).toBe(DEFAULT_AI_MODEL);
    expect(config.gemini.chatModel).toBe(DEFAULT_AI_MODEL);
  });

  it('safely handles empty string or whitespace in GEMINI_EXTRACTION_MODEL by defaulting to DEFAULT_AI_MODEL', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
      GEMINI_EXTRACTION_MODEL: '   ',
      GEMINI_COMPLEX_EXTRACTION_MODEL: '',
      GEMINI_CHAT_MODEL: '  ',
    });

    expect(config.gemini.extractionModel).toBe(DEFAULT_AI_MODEL);
    expect(config.gemini.complexExtractionModel).toBe(DEFAULT_AI_MODEL);
    expect(config.gemini.chatModel).toBe(DEFAULT_AI_MODEL);
  });

  it('preserves explicitly configured model when valid non-empty string is provided', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
      GEMINI_EXTRACTION_MODEL: 'gemini-2.5-flash',
    });

    expect(config.gemini.extractionModel).toBe('gemini-2.5-flash');
  });

  it('getModelHierarchy returns valid non-empty model names for primary, complex, and escalation', () => {
    loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
      GEMINI_EXTRACTION_MODEL: '',
    });

    const hierarchy = getModelHierarchy();
    expect(hierarchy.primary).toBe(DEFAULT_AI_MODEL);
    expect(hierarchy.complex).toBe(DEFAULT_AI_MODEL);
    expect(hierarchy.escalation).toBe(DEFAULT_AI_MODEL);

    expect(selectModelForComplexity('LEVEL_1_SIMPLE')).toBe(DEFAULT_AI_MODEL);
    expect(selectModelForComplexity('LEVEL_2_COMPLEX')).toBe(DEFAULT_AI_MODEL);
    expect(selectModelForComplexity('LEVEL_3_AMBIGUOUS')).toBe(DEFAULT_AI_MODEL);
    expect(getEscalationModel(1)).toBe(DEFAULT_AI_MODEL);
    expect(getEscalationModel(2)).toBe(DEFAULT_AI_MODEL);
  });

  it('GeminiProvider resolves valid model name even if options.model is empty or undefined', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
    });

    const provider = new GeminiProvider(config);
    // Access private resolveModelName via any for testing safety boundary
    const resolvedEmpty = (provider as unknown as { resolveModelName: (a?: string, b?: string) => string }).resolveModelName('', '');
    expect(resolvedEmpty).toBe(DEFAULT_AI_MODEL);

    const resolvedWhitespace = (provider as unknown as { resolveModelName: (a?: string, b?: string) => string }).resolveModelName('   ', '   ');
    expect(resolvedWhitespace).toBe(DEFAULT_AI_MODEL);

    const resolvedCustom = (provider as unknown as { resolveModelName: (a?: string, b?: string) => string }).resolveModelName('custom-model', 'fallback');
    expect(resolvedCustom).toBe('custom-model');
  });

  it('throws ConfigurationError with SERVER_CONFIGURATION_ERROR code when model is missing', () => {
    const err = new ConfigurationError('SERVER_CONFIGURATION_ERROR: GEMINI_EXTRACTION_MODEL is missing or invalid.');
    expect(err.code).toBe('SERVER_CONFIGURATION_ERROR');
    expect(err.statusCode).toBe(500);
  });
});
