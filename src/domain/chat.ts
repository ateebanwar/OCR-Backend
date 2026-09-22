/**
 * Domain Models for General AI Chat and Contextual Document Q&A
 */

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  systemInstruction?: string;
}

export interface ChatTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  role: 'assistant';
  content: string;
  model: string;
  usage?: ChatTokenUsage;
}

export interface ChatStreamChunk {
  text: string;
  isComplete: boolean;
}

export interface DocumentChatRequest {
  documentContext: string;
  messages: ChatMessage[];
  model?: string;
}
