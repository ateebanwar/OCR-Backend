import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import { AppConfig, getConfig } from '../config/env';
import { AIProvider } from '../providers/ai/AIProvider';
import { getAIProvider } from '../providers/ai/providerFactory';
import { createCorsOptions, isOriginAllowed } from '../security/cors';
import { requestIdHook } from '../middleware/requestId';
import { globalErrorHandler } from '../middleware/errorHandler';
import { apiRouter } from '../routes/router';

import { BlobStorageService } from '../services/BlobStorageService';

export interface BuildAppOptions {
  config?: AppConfig;
  aiProvider?: AIProvider;
  blobStorageService?: BlobStorageService;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config || getConfig();
  const aiProvider = options.aiProvider || getAIProvider(config);
  const blobStorageService = options.blobStorageService;

  const app = Fastify({
    trustProxy: true,
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          '*.password',
          '*.accessPassword',
          '*.secret',
          '*.token',
          '*.accessToken',
          '*.apiKey',
          '*.buffer',
          'req.body.password',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: config.maxUploadSizeBytes,
  });

  // Attach config to app instance for access in handlers
  (app as any).config = config;

  // 1. CORS Policy - MUST BE REGISTERED FIRST (Req 9)
  // Ensures preflight OPTIONS requests are handled with 2xx before any routes/middleware,
  // and CORS headers are established for all endpoints and error states.
  await app.register(cors, createCorsOptions(config));

  // 2. Request ID and Tracing Hook
  app.addHook('onRequest', requestIdHook);

  // 3. Ensure CORS headers on all outgoing responses (including error responses) (Req 10)
  app.addHook('onSend', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && isOriginAllowed(origin, config)) {
      if (!reply.getHeader('access-control-allow-origin')) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Access-Control-Expose-Headers', 'X-Request-ID, Content-Disposition, Content-Type');
        reply.header('Vary', 'Origin');
      }
    }
  });

  app.addHook('onError', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && isOriginAllowed(origin, config)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Expose-Headers', 'X-Request-ID, Content-Disposition, Content-Type');
      reply.header('Vary', 'Origin');
    }
  });

  // 4. Security Headers (@fastify/helmet)
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    noSniff: true,
  });

  // 5. Rate Limiting Policy
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    keyGenerator: (request: FastifyRequest) => {
      const forwarded = request.headers['x-forwarded-for'];
      const realIp = request.headers['x-real-ip'];
      if (typeof forwarded === 'string') {
        const client = forwarded.split(',')[0]?.trim();
        if (client) return client;
      }
      if (typeof realIp === 'string' && realIp.trim()) {
        return realIp.trim();
      }
      return request.ip || '127.0.0.1';
    },
  });

  // 6. Utility & Multipart Plugins (Req 8: multipart works through CORS)
  await app.register(sensible);
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadSizeBytes,
      files: 1,
    },
  });

  // 7. Centralized Global Error Handler
  app.setErrorHandler(globalErrorHandler);

  // 8. Register Routes
  await app.register(apiRouter, { config, aiProvider, blobStorageService });

  return app;
}
