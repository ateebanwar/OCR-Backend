import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppConfig } from '../../config/env';
import { AccessService } from '../../services/AccessService';
import { formatSuccessResponse } from '../../api/response';
import { AuthenticationError, ValidationError } from '../../errors/AppError';

export interface AccessRouteOptions {
  config: AppConfig;
  accessService?: AccessService;
}

const verifyAccessSchema = z.object({
  name: z.string().optional().default(''),
  dob: z.string().optional().default(''),
  gender: z.string().optional().default(''),
  email: z.string().email().optional().or(z.literal('')).default(''),
  password: z.string().min(1, 'Password is required'),
});

export const accessRoutes: FastifyPluginAsync<AccessRouteOptions> = async (
  fastify: FastifyInstance,
  options
) => {
  const { config } = options;
  const accessService = options.accessService || new AccessService(config);

  // GET /api/v1/access/status
  // Public endpoint: returns whether a password gate is required. Never reveals secrets.
  fastify.get('/status', async (request, reply) => {
    return reply.status(200).send(
      formatSuccessResponse(
        {
          passwordRequired: accessService.isPasswordRequired(),
        },
        request.requestId
      )
    );
  });

  // POST /api/v1/access/verify
  // Verifies user-entered password against server configuration in constant time.
  // Enforces strict rate-limiting against brute force attempts.
  fastify.post(
    '/verify',
    {
      config: {
        rateLimit: {
          max: config.accessRateLimitMax,
          timeWindow: config.accessRateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      const parseResult = verifyAccessSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new ValidationError('Invalid verification request payload.', parseResult.error.errors);
      }

      const { password } = parseResult.data;

      // If password requirement is enabled, verify the submitted password server-side
      if (accessService.isPasswordRequired()) {
        const isValid = accessService.verifyPassword(password);
        if (!isValid) {
          throw new AuthenticationError(
            'Invalid access credentials.',
            'INVALID_ACCESS_PASSWORD'
          );
        }
      }

      // Generate short-lived stateless signed access token
      const accessToken = accessService.generateAccessToken();

      return reply.status(200).send(
        formatSuccessResponse(
          {
            authenticated: true,
            accessToken,
          },
          request.requestId
        )
      );
    }
  );
};
