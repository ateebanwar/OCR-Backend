import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './v1/health';
import { documentRoutes } from './v1/documents';
import { chatRoutes } from './v1/chat';
import { accessRoutes } from './v1/access';
import { AppConfig } from '../config/env';
import { AIProvider } from '../providers/ai/AIProvider';
import { BlobStorageService } from '../services/BlobStorageService';

export interface ApiRouterOptions {
  config: AppConfig;
  aiProvider: AIProvider;
  blobStorageService?: BlobStorageService;
}

export const apiRouter: FastifyPluginAsync<ApiRouterOptions> = async (
  fastify: FastifyInstance,
  options
) => {
  const { config, aiProvider, blobStorageService } = options;

  // Root redirect/welcome route for testing root URL
  fastify.get('/', async (_request, reply) => {
    return reply.status(200).send({
      name: 'Financial Document Intelligence API',
      version: '1.0.0',
      status: 'active',
      documentation: '/api/v1/health',
    });
  });

  // Register versioned API routes under /api/v1
  await fastify.register(
    async (v1) => {
      await v1.register(healthRoutes, { config });
      await v1.register(accessRoutes, { config, prefix: '/access' });
      await v1.register(documentRoutes, { config, aiProvider, blobStorageService });
      await v1.register(chatRoutes, { config, aiProvider });
    },
    { prefix: '/api/v1' }
  );
};
