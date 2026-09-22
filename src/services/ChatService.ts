import { AIProvider } from '../providers/ai/AIProvider';
import { ChatMessage, ChatResponse, ChatStreamChunk, DocumentChatRequest } from '../domain/chat';
import { AppConfig } from '../config/env';
import { ValidationError } from '../errors/AppError';

export class ChatService {
  private aiProvider: AIProvider;
  private config: AppConfig;

  constructor(aiProvider: AIProvider, config: AppConfig) {
    this.aiProvider = aiProvider;
    this.config = config;
  }

  public async chat(
    messages: ChatMessage[],
    modelOverride?: string
  ): Promise<ChatResponse> {
    if (!messages || messages.length === 0) {
      throw new ValidationError('Chat messages list cannot be empty.');
    }

    const model = modelOverride || this.config.gemini.chatModel;
    return this.aiProvider.chat(messages, {
      model,
      systemInstruction:
        'You are a professional financial intelligence assistant. Answer questions clearly, accurately, and politely.',
    });
  }

  public streamChat(
    messages: ChatMessage[],
    modelOverride?: string
  ): AsyncIterable<ChatStreamChunk> {
    if (!messages || messages.length === 0) {
      throw new ValidationError('Chat messages list cannot be empty.');
    }

    const model = modelOverride || this.config.gemini.chatModel;
    return this.aiProvider.streamChat(messages, {
      model,
      systemInstruction:
        'You are a professional financial intelligence assistant. Answer questions clearly, accurately, and politely.',
    });
  }

  public async chatWithDocument(
    request: DocumentChatRequest
  ): Promise<ChatResponse> {
    if (!request.messages || request.messages.length === 0) {
      throw new ValidationError('Chat messages cannot be empty.');
    }

    const systemInstruction = `You are a financial analyst discussing a specific financial document.
DOCUMENT CONTEXT:
${request.documentContext}

Answer the user's questions strictly based on this document. If information is not in the document, state so clearly. Do not speculate or invent numbers.`;

    const model = request.model || this.config.gemini.chatModel;
    return this.aiProvider.chat(request.messages, {
      model,
      systemInstruction,
    });
  }
}
