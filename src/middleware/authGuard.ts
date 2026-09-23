import { FastifyReply, FastifyRequest } from 'fastify';
import { AppConfig } from '../config/env';
import { AccessService } from '../services/AccessService';
import { AuthenticationError } from '../errors/AppError';

export function createAuthGuard(config: AppConfig, accessService?: AccessService) {
  const service = accessService || new AccessService(config);

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    // If password requirement is disabled, allow requests through without token
    if (!config.requirePassword) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string') {
      throw new AuthenticationError(
        'Authentication credentials are required.',
        'AUTHENTICATION_REQUIRED'
      );
    }

    const parts = authHeader.trim().split(/\s+/);
    const scheme = parts[0];
    const token = parts[1];
    if (parts.length !== 2 || !scheme || scheme.toLowerCase() !== 'bearer' || !token) {
      throw new AuthenticationError(
        'Authentication credentials are required.',
        'AUTHENTICATION_REQUIRED'
      );
    }

    const verification = service.verifyAccessToken(token);
    if (!verification.valid) {
      throw new AuthenticationError(
        'Invalid or expired access token.',
        'INVALID_ACCESS_TOKEN'
      );
    }
  };
}
