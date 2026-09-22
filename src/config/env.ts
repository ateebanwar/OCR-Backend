import { z } from 'zod';
import { ConfigurationError } from '../errors/AppError';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  
  AI_PROVIDER: z.string().default('gemini'),
  
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_EXTRACTION_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_COMPLEX_EXTRACTION_MODEL: z.string().default('gemini-2.5-pro'),
  GEMINI_CHAT_MODEL: z.string().default('gemini-2.5-flash'),
  
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000'),
  
  MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().default(15),
  MAX_PDF_PAGES: z.coerce.number().positive().max(500).default(50),
  REQUEST_TIMEOUT_MS: z.coerce.number().positive().default(60000),
  AI_TIMEOUT_MS: z.coerce.number().positive().default(60000),
  
  RATE_LIMIT_MAX: z.coerce.number().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(60000),
  MAX_CONCURRENT_PROCESSING: z.coerce.number().positive().default(5),
  MAX_OUTPUT_SIZE_MB: z.coerce.number().positive().default(20),
  
  MAX_EXTRACTION_RETRIES: z.coerce.number().min(0).max(5).default(2),
  MAX_ESCALATION_LEVELS: z.coerce.number().min(0).max(3).default(2),
});

export type RawConfig = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  aiProvider: string;
  gemini: {
    apiKey: string;
    extractionModel: string;
    complexExtractionModel: string;
    chatModel: string;
  };
  allowedOrigins: string[];
  maxUploadSizeBytes: number;
  maxPdfPages: number;
  requestTimeoutMs: number;
  aiTimeoutMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  maxConcurrentProcessing: number;
  maxOutputSizeBytes: number;
  maxExtractionRetries: number;
  maxEscalationLevels: number;
  isProduction: boolean;
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(customEnv: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(customEnv);
  
  if (!result.success) {
    const errorDetails = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new ConfigurationError(`Environment configuration error: ${errorDetails}`);
  }

  const raw = result.data;

  // Strict check: In production or when gemini provider is explicitly chosen outside test, API key must be provided
  if (raw.NODE_ENV === 'production' && raw.AI_PROVIDER === 'gemini' && (!raw.GEMINI_API_KEY || raw.GEMINI_API_KEY.includes('PASTE_YOUR'))) {
    throw new ConfigurationError('GEMINI_API_KEY is required and must not be a placeholder in production environments.');
  }

  const allowedOrigins = raw.ALLOWED_ORIGINS
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const config: AppConfig = {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    host: raw.HOST,
    logLevel: raw.LOG_LEVEL,
    aiProvider: raw.AI_PROVIDER.toLowerCase(),
    gemini: {
      apiKey: raw.GEMINI_API_KEY,
      extractionModel: raw.GEMINI_EXTRACTION_MODEL,
      complexExtractionModel: raw.GEMINI_COMPLEX_EXTRACTION_MODEL,
      chatModel: raw.GEMINI_CHAT_MODEL,
    },
    allowedOrigins,
    maxUploadSizeBytes: raw.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
    maxPdfPages: raw.MAX_PDF_PAGES,
    requestTimeoutMs: raw.REQUEST_TIMEOUT_MS,
    aiTimeoutMs: raw.AI_TIMEOUT_MS,
    rateLimitMax: raw.RATE_LIMIT_MAX,
    rateLimitWindowMs: raw.RATE_LIMIT_WINDOW_MS,
    maxConcurrentProcessing: raw.MAX_CONCURRENT_PROCESSING,
    maxOutputSizeBytes: raw.MAX_OUTPUT_SIZE_MB * 1024 * 1024,
    maxExtractionRetries: raw.MAX_EXTRACTION_RETRIES,
    maxEscalationLevels: raw.MAX_ESCALATION_LEVELS,
    isProduction: raw.NODE_ENV === 'production',
  };

  cachedConfig = config;
  return config;
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}
