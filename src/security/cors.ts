import { FastifyCorsOptions } from '@fastify/cors';
import { AppConfig } from '../config/env';

export function createCorsOptions(config: AppConfig): FastifyCorsOptions {
  return {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server) in non-production
      if (!origin) {
        cb(null, !config.isProduction);
        return;
      }

      if (config.allowedOrigins.includes(origin) || (config.frontendOrigin && origin === config.frontendOrigin)) {
        cb(null, true);
        return;
      }

      // In development, permit localhost on any port
      if (!config.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        cb(null, true);
        return;
      }

      cb(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'Content-Disposition'],
    credentials: true,
    maxAge: 86400,
  };
}
