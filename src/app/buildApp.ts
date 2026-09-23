import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import { AppConfig, getConfig } from '../config/env';
import { AIProvider } from '../providers/ai/AIProvider';
import { getAIProvider } from '../providers/ai/providerFactory';
import { createCorsOptions } from '../security/cors';
import { requestIdHook } from '../middleware/requestId';
import { globalErrorHandler } from '../middleware/errorHandler';
import { apiRouter } from '../routes/router';

export interface BuildAppOptions {
  config?: AppConfig;
  aiProvider?: AIProvider;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config || getConfig();
  const aiProvider = options.aiProvider || getAIProvider(config);

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

  // Request ID and Tracing Hook (registered first for all subsequent middlewares)
  app.addHook('onRequest', requestIdHook);

  // Security Headers (@fastify/helmet)
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

  // CORS Policy
  await app.register(cors, createCorsOptions(config));

  // Rate Limiting Policy
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

  // Utility & Multipart Plugins
  await app.register(sensible);
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadSizeBytes,
      files: 1,
    },
  });

  // Centralized Global Error Handler
  app.setErrorHandler(globalErrorHandler);

  // Register Routes
  await app.register(apiRouter, { config, aiProvider });

  return app;
}
