import { FastifyCorsOptions } from '@fastify/cors';
import { AppConfig } from '../config/env';

/**
 * Known production origins for deployed frontend instances.
 */
export const DEFAULT_PRODUCTION_ORIGINS = [
  'https://ocr-front-end-iota.vercel.app',
  'https://ocr-frontend-iota.vercel.app',
];

/**
 * Standard development origins permitted across all environments
 * to allow local client development against both dev and deployed instances.
 */
export const DEFAULT_LOCAL_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export const LOCAL_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Matches official Vercel preview and production deployments for OCR Frontend:
 * e.g. https://ocr-front-end-iota.vercel.app, https://ocr-front-end-*.vercel.app,
 * https://ocr-frontend-*.vercel.app.
 */
export const VERCEL_FRONTEND_REGEX = /^https?:\/\/(ocr-front-end[a-zA-Z0-9-]*|ocr-frontend[a-zA-Z0-9-]*|ocr-[a-zA-Z0-9-]+)\.vercel\.app$/i;

/**
 * Validates whether an incoming HTTP Origin is permitted under strict security rules.
 * Never uses wildcard '*' in production or authenticated endpoints.
 */
export function isOriginAllowed(origin: string | undefined, config: AppConfig): boolean {
  // Allow requests with no origin (curl, server-to-server, health checks, background workers)
  if (!origin) {
    return true;
  }

  const normalized = origin.trim().replace(/\/+$/, '');

  // 1. Known deployed production frontend origins
  if (DEFAULT_PRODUCTION_ORIGINS.includes(normalized)) {
    return true;
  }

  // 2. Configured frontendOrigin takes highest priority for production deployment
  if (config.frontendOrigin && config.frontendOrigin.trim().replace(/\/+$/, '') === normalized) {
    return true;
  }

  // 3. Explicitly configured allowedOrigins list
  if (config.allowedOrigins && config.allowedOrigins.some(o => o.trim().replace(/\/+$/, '') === normalized)) {
    return true;
  }

  // 4. Known local development origins (http://127.0.0.1:3000, http://localhost:3000, etc.)
  if (DEFAULT_LOCAL_ORIGINS.includes(normalized)) {
    return true;
  }

  // 5. Localhost / 127.0.0.1 on any port for local development flexibility
  if (LOCAL_ORIGIN_REGEX.test(normalized)) {
    return true;
  }

  // 6. Vercel deployment preview / production domains for this OCR frontend
  if (VERCEL_FRONTEND_REGEX.test(normalized)) {
    return true;
  }

  return false;
}

export function createCorsOptions(config: AppConfig): FastifyCorsOptions {
  return {
    origin: (origin, cb) => {
      if (isOriginAllowed(origin, config)) {
        cb(null, true);
      } else {
        // Disallow origin cleanly without throwing 500 error or leaking stack trace
        cb(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-ID',
      'Accept',
      'Origin',
      'X-Requested-With',
      'Cache-Control',
      'Pragma',
      'X-Forwarded-For',
    ],
    exposedHeaders: [
      'X-Request-ID',
      'Content-Disposition',
      'Content-Type',
    ],
    credentials: true,
    maxAge: 86400,
    preflight: true,
    strictPreflight: false,
    optionsSuccessStatus: 204,
  };
}
