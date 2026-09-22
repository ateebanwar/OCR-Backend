import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { formatSuccessResponse } from '../../api/response';
import { AppConfig } from '../../config/env';

export const healthRoutes: FastifyPluginAsync<{ config: AppConfig }> = async (
  fastify: FastifyInstance,
  options
) => {
  const { config } = options;

  fastify.get('/health', async (request, reply) => {
    const healthData = {
      status: 'healthy',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      provider: config.aiProvider,
      environment: config.nodeEnv,
      version: '1.0.0',
    };

    return reply.status(200).send(formatSuccessResponse(healthData, request.requestId));
  });
};
