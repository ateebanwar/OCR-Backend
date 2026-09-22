import { ChatMessage, ChatOptions, ChatResponse, ChatStreamChunk } from '../../domain/chat';

export interface DocumentInput {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export interface ExtractionPromptContext {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema?: Record<string, unknown>;
}

export interface ProviderOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface DocumentAnalysisResult {
  summary: string;
  detectedType: string;
  pageCountEstimate?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderHealth {
  isHealthy: boolean;
  provider: string;
  latencyMs?: number;
  message?: string;
}

export interface AIProvider {
  readonly providerName: string;

  analyzeDocument(
    doc: DocumentInput,
    options?: ProviderOptions
  ): Promise<DocumentAnalysisResult>;

  extractStructuredData<T>(
    doc: DocumentInput,
    promptContext: ExtractionPromptContext,
    options?: ProviderOptions
  ): Promise<T>;

  chat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ChatResponse>;

  streamChat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncIterable<ChatStreamChunk>;

  healthCheck(): Promise<ProviderHealth>;
}
