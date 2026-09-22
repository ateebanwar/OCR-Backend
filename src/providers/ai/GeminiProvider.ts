import { GoogleGenerativeAI, Part, Content } from '@google/generative-ai';
import {
  AIProvider,
  DocumentAnalysisResult,
  DocumentInput,
  ExtractionPromptContext,
  ProviderHealth,
  ProviderOptions,
} from './AIProvider';
import { ChatMessage, ChatOptions, ChatResponse, ChatStreamChunk } from '../../domain/chat';
import { AppError, ConfigurationError, ProviderError, ProviderTimeoutError } from '../../errors/AppError';
import { AppConfig, DEFAULT_AI_MODEL } from '../../config/env';

export class GeminiProvider implements AIProvider {
  public readonly providerName = 'gemini';
  private genAI: GoogleGenerativeAI | null = null;
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    if (config.gemini.apiKey) {
      this.genAI = new GoogleGenerativeAI(config.gemini.apiKey);
    }
  }

  private resolveModelName(candidate?: string, fallbackConfigured?: string): string {
    if (candidate && typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (fallbackConfigured && typeof fallbackConfigured === 'string' && fallbackConfigured.trim().length > 0) {
      return fallbackConfigured.trim();
    }
    return DEFAULT_AI_MODEL;
  }

  private getClient(): GoogleGenerativeAI {
    if (!this.genAI) {
      if (!this.config.gemini.apiKey) {
        throw new ProviderError(
          'Gemini API key is not configured. Please set GEMINI_API_KEY environment variable.'
        );
      }
      this.genAI = new GoogleGenerativeAI(this.config.gemini.apiKey);
    }
    return this.genAI;
  }

  private async executeWithTimeout<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    timeoutMs: number,
    retries: number = 1
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        return await operation(controller.signal);
      } catch (err: unknown) {
        lastError = err;
        if (controller.signal.aborted) {
          throw new ProviderTimeoutError(`Gemini request timed out after ${timeoutMs}ms.`);
        }
        const message = err instanceof Error ? err.message : String(err);
        const isTransient =
          message.includes('503') ||
          message.toLowerCase().includes('high demand') ||
          message.includes('429');

        if (isTransient && attempt < retries) {
          const delayMs = 1000 * (attempt + 1) + Math.random() * 500;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        if (message.includes('429') || message.toLowerCase().includes('quota')) {
          throw new ProviderError(`Gemini rate limit exceeded: ${message}`);
        }
        throw new ProviderError(`Gemini API error: ${message}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new ProviderError(`Gemini API error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  public async analyzeDocument(
    doc: DocumentInput,
    options?: ProviderOptions
  ): Promise<DocumentAnalysisResult> {
    const client = this.getClient();
    const primaryModel = this.resolveModelName(options?.model, this.config.gemini.extractionModel);
    if (!primaryModel) {
      throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: AI extraction model is missing or invalid.');
    }
    const timeoutMs = options?.timeoutMs || this.config.requestTimeoutMs;

    const candidateModels = [primaryModel];
    if (primaryModel !== 'gemini-flash-lite-latest') {
      candidateModels.push('gemini-flash-lite-latest');
    }

    const pdfPart: Part = {
      inlineData: {
        data: doc.buffer.toString('base64'),
        mimeType: doc.mimeType,
      },
    };

    const prompt =
      'Analyze this financial document. Identify the document type (invoice, receipt, statement, bill, etc.), total pages, summary of contents, and any notable structural characteristics. Output JSON with fields: { "detectedType": string, "summary": string, "pageCountEstimate": number }.';

    let lastError: unknown;
    for (let i = 0; i < candidateModels.length; i++) {
      const modelName = candidateModels[i]!;
      try {
        const model = client.getGenerativeModel({ model: modelName });
        const result = await this.executeWithTimeout(async () => {
          const response = await model.generateContent({
            contents: [{ role: 'user', parts: [pdfPart, { text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: options?.temperature ?? 0.1,
            },
          });
          return response.response.text();
        }, timeoutMs);

        try {
          const parsed = JSON.parse(result) as {
            detectedType?: string;
            summary?: string;
            pageCountEstimate?: number;
          };
          return {
            detectedType: parsed.detectedType || 'financial_document',
            summary: parsed.summary || 'Financial document analysis completed',
            pageCountEstimate: parsed.pageCountEstimate,
          };
        } catch {
          return {
            detectedType: 'financial_document',
            summary: result.slice(0, 300),
          };
        }
      } catch (err: unknown) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient =
          msg.includes('503') ||
          msg.toLowerCase().includes('high demand') ||
          msg.includes('429');

        if (isTransient && i < candidateModels.length - 1) {
          continue;
        }
        if (err instanceof ProviderError || err instanceof ProviderTimeoutError || err instanceof ConfigurationError) {
          throw err;
        }
        throw new ProviderError(`Gemini API error: ${msg}`);
      }
    }

    throw lastError instanceof AppError
      ? lastError
      : new ProviderError(`Document analysis failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  public async extractStructuredData<T>(
    doc: DocumentInput,
    promptContext: ExtractionPromptContext,
    options?: ProviderOptions
  ): Promise<T> {
    const client = this.getClient();
    const primaryModel = this.resolveModelName(options?.model, this.config.gemini.extractionModel);
    if (!primaryModel) {
      throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: AI extraction model is missing or invalid.');
    }
    const timeoutMs = options?.timeoutMs || this.config.requestTimeoutMs;

    const candidateModels = [primaryModel];
    if (primaryModel !== 'gemini-flash-lite-latest') {
      candidateModels.push('gemini-flash-lite-latest');
    }

    const pdfPart: Part = {
      inlineData: {
        data: doc.buffer.toString('base64'),
        mimeType: doc.mimeType,
      },
    };

    let lastError: unknown;
    for (let i = 0; i < candidateModels.length; i++) {
      const modelName = candidateModels[i]!;
      try {
        const model = client.getGenerativeModel({
          model: modelName,
          systemInstruction: promptContext.systemPrompt,
        });

        const rawOutput = await this.executeWithTimeout(async () => {
          const response = await model.generateContent({
            contents: [
              {
                role: 'user',
                parts: [pdfPart, { text: promptContext.userPrompt }],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: options?.temperature ?? 0.0,
              maxOutputTokens: options?.maxOutputTokens ?? 8192,
            },
          });
          return response.response.text();
        }, timeoutMs);

        const cleaned = this.cleanJsonOutput(rawOutput);
        return JSON.parse(cleaned) as T;
      } catch (err: unknown) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient =
          msg.includes('503') ||
          msg.toLowerCase().includes('high demand') ||
          msg.includes('429');

        if (isTransient && i < candidateModels.length - 1) {
          continue;
        }

        if (err instanceof ProviderError || err instanceof ProviderTimeoutError || err instanceof ConfigurationError) {
          throw err;
        }
        throw new ProviderError(`Gemini API error: ${msg}`);
      }
    }

    throw lastError instanceof AppError
      ? lastError
      : new ProviderError(`Failed to extract structured data: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }


  public async chat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ChatResponse> {
    const client = this.getClient();
    const modelName = this.resolveModelName(options?.model, this.config.gemini.chatModel);
    const timeoutMs = this.config.requestTimeoutMs;

    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction: options?.systemInstruction,
    });

    const contents: Content[] = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));

    const response = await this.executeWithTimeout(async () => {
      const result = await model.generateContent({
        contents,
        generationConfig: {
          temperature: options?.temperature ?? 0.7,
          maxOutputTokens: options?.maxOutputTokens,
        },
      });
      return result.response;
    }, timeoutMs);

    const text = response.text();
    const usage = response.usageMetadata
      ? {
          promptTokens: response.usageMetadata.promptTokenCount,
          completionTokens: response.usageMetadata.candidatesTokenCount,
          totalTokens: response.usageMetadata.totalTokenCount,
        }
      : undefined;

    return {
      role: 'assistant',
      content: text,
      model: modelName,
      usage,
    };
  }

  public async *streamChat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<ChatStreamChunk> {
    const client = this.getClient();
    const modelName = this.resolveModelName(options?.model, this.config.gemini.chatModel);

    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction: options?.systemInstruction,
    });

    const contents: Content[] = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));

    const responseStream = await model.generateContentStream({
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxOutputTokens,
      },
    });

    for await (const chunk of responseStream.stream) {
      const chunkText = chunk.text();
      if (chunkText) {
        yield { text: chunkText, isComplete: false };
      }
    }

    yield { text: '', isComplete: true };
  }

  public async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      if (!this.config.gemini.apiKey) {
        return {
          isHealthy: false,
          provider: this.providerName,
          message: 'Gemini API key is not configured',
        };
      }

      // Fast check with minimal tokens
      const client = this.getClient();
      const modelName = this.resolveModelName(undefined, this.config.gemini.chatModel);
      const model = client.getGenerativeModel({ model: modelName });
      await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 2 },
      });

      return {
        isHealthy: true,
        provider: this.providerName,
        latencyMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      return {
        isHealthy: false,
        provider: this.providerName,
        latencyMs: Date.now() - startTime,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private cleanJsonOutput(raw: string): string {
    let text = raw.trim();
    if (text.startsWith('```json')) {
      text = text.slice(7);
    } else if (text.startsWith('```')) {
      text = text.slice(3);
    }
    if (text.endsWith('```')) {
      text = text.slice(0, -3);
    }
    return text.trim();
  }
}
