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
import { ProviderError, ProviderTimeoutError } from '../../errors/AppError';
import { AppConfig } from '../../config/env';

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
    timeoutMs: number
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await operation(controller.signal);
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new ProviderTimeoutError(`Gemini request timed out after ${timeoutMs}ms.`);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('429') || message.toLowerCase().includes('quota')) {
        throw new ProviderError(`Gemini rate limit exceeded: ${message}`);
      }
      throw new ProviderError(`Gemini API error: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  public async analyzeDocument(
    doc: DocumentInput,
    options?: ProviderOptions
  ): Promise<DocumentAnalysisResult> {
    const client = this.getClient();
    const modelName = options?.model || this.config.gemini.extractionModel;
    const timeoutMs = options?.timeoutMs || this.config.requestTimeoutMs;

    const model = client.getGenerativeModel({ model: modelName });
    const pdfPart: Part = {
      inlineData: {
        data: doc.buffer.toString('base64'),
        mimeType: doc.mimeType,
      },
    };

    const prompt =
      'Analyze this financial document. Identify the document type (invoice, receipt, statement, bill, etc.), total pages, summary of contents, and any notable structural characteristics. Output JSON with fields: { "detectedType": string, "summary": string, "pageCountEstimate": number }.';

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
  }

  public async extractStructuredData<T>(
    doc: DocumentInput,
    promptContext: ExtractionPromptContext,
    options?: ProviderOptions
  ): Promise<T> {
    const client = this.getClient();
    const modelName = options?.model || this.config.gemini.extractionModel;
    const timeoutMs = options?.timeoutMs || this.config.requestTimeoutMs;

    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction: promptContext.systemPrompt,
    });

    const pdfPart: Part = {
      inlineData: {
        data: doc.buffer.toString('base64'),
        mimeType: doc.mimeType,
      },
    };

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

    try {
      const cleaned = this.cleanJsonOutput(rawOutput);
      return JSON.parse(cleaned) as T;
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new ProviderError(`Failed to parse structured JSON from Gemini response: ${msg}. Output preview: ${rawOutput.slice(0, 200)}`);
    }
  }

  public async chat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ChatResponse> {
    const client = this.getClient();
    const modelName = options?.model || this.config.gemini.chatModel;
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
    const modelName = options?.model || this.config.gemini.chatModel;

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
      const model = client.getGenerativeModel({ model: this.config.gemini.chatModel });
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
