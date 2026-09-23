import { z } from 'zod';
import { ConfigurationError } from '../errors/AppError';

export const DEFAULT_TIER1_MODEL = 'gemini-3.6-flash';
export const DEFAULT_TIER2_MODEL = 'gemini-3.7-flash';
export const DEFAULT_TIER3_MODEL = 'gemini-3.8-flash';
export const DEFAULT_VERIFICATION_MODEL = 'gemini-3.7-flash';
export const DEFAULT_CHAT_MODEL = 'gemini-3.6-flash';
export const DEFAULT_AI_MODEL = DEFAULT_TIER1_MODEL;

const safeModelSchema = (defaultModel: string = DEFAULT_AI_MODEL) =>
  z.preprocess((val) => {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
    return defaultModel;
  }, z.string().min(1).default(defaultModel));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  
  AI_PROVIDER: z.string().default('gemini'),
  
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_EXTRACTION_MODEL: safeModelSchema(DEFAULT_TIER1_MODEL),
  GEMINI_COMPLEX_EXTRACTION_MODEL: safeModelSchema(DEFAULT_TIER2_MODEL),
  GEMINI_ESCALATION_MODEL: safeModelSchema(DEFAULT_TIER3_MODEL),
  GEMINI_VERIFICATION_MODEL: safeModelSchema(DEFAULT_VERIFICATION_MODEL),
  GEMINI_CHAT_MODEL: safeModelSchema(DEFAULT_CHAT_MODEL),
  
  ALLOWED_ORIGINS: z.string().default('https://ocr-front-end-iota.vercel.app,http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000'),
  
  MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().default(25),
  DIRECT_UPLOAD_MAX_MB: z.coerce.number().positive().default(4),
  MAX_PDF_PAGES: z.coerce.number().positive().max(500).default(50),
  REQUEST_TIMEOUT_MS: z.coerce.number().positive().default(60000),
  AI_TIMEOUT_MS: z.coerce.number().positive().default(60000),
  
  BLOB_READ_WRITE_TOKEN: z.string().optional().default(''),
  
  RATE_LIMIT_MAX: z.coerce.number().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(60000),
  MAX_CONCURRENT_PROCESSING: z.coerce.number().positive().default(5),
  MAX_OUTPUT_SIZE_MB: z.coerce.number().positive().default(20),
  
  MAX_EXTRACTION_RETRIES: z.coerce.number().min(0).max(5).default(2),
  MAX_ESCALATION_LEVELS: z.coerce.number().min(0).max(3).default(2),

  REQUIRE_PASSWORD: z.preprocess((val) => {
    if (typeof val === 'string') {
      return val.trim().toLowerCase() === 'true';
    }
    return Boolean(val);
  }, z.boolean()).default(false),
  ACCESS_PASSWORD: z.string().optional().default(''),
  ACCESS_TOKEN_SECRET: z.string().optional().default(''),
  ACCESS_TOKEN_TTL: z.string().default('30m'),
  ACCESS_AUTH_VERSION: z.string().default('1'),
  ACCESS_RATE_LIMIT_MAX: z.coerce.number().positive().default(5),
  ACCESS_RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(60000),
  FRONTEND_ORIGIN: z.string().optional(),
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
    escalationModel: string;
    verificationModel: string;
    chatModel: string;
  };
  allowedOrigins: string[];
  maxUploadSizeBytes: number;
  directUploadMaxBytes: number;
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
  requirePassword: boolean;
  accessPassword?: string;
  accessTokenSecret: string;
  accessTokenTtl: string;
  accessAuthVersion: string;
  accessRateLimitMax: number;
  accessRateLimitWindowMs: number;
  frontendOrigin?: string;
  blobReadWriteToken?: string;
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(customEnv: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(customEnv);
  
  if (!result.success) {
    const errorDetails = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new ConfigurationError(`Environment configuration error: ${errorDetails}`);
  }

  const raw = result.data;

  // Check: In production or when gemini provider is explicitly chosen outside test, warn if API key is missing
  if (raw.NODE_ENV === 'production' && raw.AI_PROVIDER === 'gemini' && (!raw.GEMINI_API_KEY || raw.GEMINI_API_KEY.includes('PASTE_YOUR'))) {
    console.warn('[SECURITY WARNING] GEMINI_API_KEY is not configured or is a placeholder in production.');
  }

  // Access gate validation: If password is required, ACCESS_PASSWORD must be configured
  if (raw.REQUIRE_PASSWORD) {
    if (!raw.ACCESS_PASSWORD || !raw.ACCESS_PASSWORD.trim()) {
      throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: ACCESS_PASSWORD is required when REQUIRE_PASSWORD=true.');
    }
    if (raw.NODE_ENV === 'production' && (!raw.ACCESS_TOKEN_SECRET || !raw.ACCESS_TOKEN_SECRET.trim())) {
      throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: ACCESS_TOKEN_SECRET must be configured in production when REQUIRE_PASSWORD=true.');
    }
  }

  const allowedOrigins = raw.ALLOWED_ORIGINS
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (raw.FRONTEND_ORIGIN && raw.FRONTEND_ORIGIN.trim()) {
    const origin = raw.FRONTEND_ORIGIN.trim();
    if (!allowedOrigins.includes(origin)) {
      allowedOrigins.push(origin);
    }
  }

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
      escalationModel: raw.GEMINI_ESCALATION_MODEL,
      verificationModel: raw.GEMINI_VERIFICATION_MODEL,
      chatModel: raw.GEMINI_CHAT_MODEL,
    },
    allowedOrigins,
    maxUploadSizeBytes: raw.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
    directUploadMaxBytes: raw.DIRECT_UPLOAD_MAX_MB * 1024 * 1024,
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
    requirePassword: raw.REQUIRE_PASSWORD,
    accessPassword: raw.ACCESS_PASSWORD && raw.ACCESS_PASSWORD.trim() ? raw.ACCESS_PASSWORD.trim() : undefined,
    accessTokenSecret: raw.ACCESS_TOKEN_SECRET && raw.ACCESS_TOKEN_SECRET.trim()
      ? raw.ACCESS_TOKEN_SECRET.trim()
      : 'fallback_dev_access_token_secret_do_not_use_in_production',
    accessTokenTtl: raw.ACCESS_TOKEN_TTL.trim() || '30m',
    accessAuthVersion: raw.ACCESS_AUTH_VERSION.trim() || '1',
    accessRateLimitMax: raw.ACCESS_RATE_LIMIT_MAX,
    accessRateLimitWindowMs: raw.ACCESS_RATE_LIMIT_WINDOW_MS,
    frontendOrigin: raw.FRONTEND_ORIGIN?.trim(),
    blobReadWriteToken: (() => {
      const rawToken = raw.BLOB_READ_WRITE_TOKEN?.trim();
      if (!rawToken) return undefined;
      let t = rawToken;
      if (t.startsWith('BLOB_READ_WRITE_TOKEN=')) {
        t = t.slice('BLOB_READ_WRITE_TOKEN='.length).trim();
      }
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1).trim();
      }
      return t.length > 0 ? t : undefined;
    })(),
  };

  // Startup validation: Ensure model names are non-empty
  if (!config.gemini.extractionModel || !config.gemini.extractionModel.trim()) {
    throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: GEMINI_EXTRACTION_MODEL is missing or invalid.');
  }
  if (!config.gemini.complexExtractionModel || !config.gemini.complexExtractionModel.trim()) {
    throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: GEMINI_COMPLEX_EXTRACTION_MODEL is missing or invalid.');
  }
  if (!config.gemini.escalationModel || !config.gemini.escalationModel.trim()) {
    throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: GEMINI_ESCALATION_MODEL is missing or invalid.');
  }
  if (!config.gemini.verificationModel || !config.gemini.verificationModel.trim()) {
    throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: GEMINI_VERIFICATION_MODEL is missing or invalid.');
  }

  cachedConfig = config;
  return config;
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}

