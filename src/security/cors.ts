import { FastifyCorsOptions } from '@fastify/cors';
import { AppConfig } from '../config/env';

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
 * Validates whether an incoming HTTP Origin is permitted under strict security rules.
 * Never uses wildcard '*' in production or authenticated endpoints.
 */
export function isOriginAllowed(origin: string | undefined, config: AppConfig): boolean {
  // Allow requests with no origin (curl, server-to-server, health checks, background workers)
  if (!origin) {
    return true;
  }

  const normalized = origin.trim().replace(/\/+$/, '');

  // 1. Configured frontendOrigin takes highest priority for production deployment
  if (config.frontendOrigin && config.frontendOrigin.trim().replace(/\/+$/, '') === normalized) {
    return true;
  }

  // 2. Explicitly configured allowedOrigins list
  if (config.allowedOrigins && config.allowedOrigins.some(o => o.trim().replace(/\/+$/, '') === normalized)) {
    return true;
  }

  // 3. Known local development origins (http://127.0.0.1:3000, http://localhost:3000, etc.)
  if (DEFAULT_LOCAL_ORIGINS.includes(normalized)) {
    return true;
  }

  // 4. Localhost / 127.0.0.1 on any port for local development flexibility
  if (LOCAL_ORIGIN_REGEX.test(normalized)) {
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
