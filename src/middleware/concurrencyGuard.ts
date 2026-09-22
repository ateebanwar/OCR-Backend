import { FastifyReply, FastifyRequest } from 'fastify';
import { AppConfig } from '../config/env';
import { formatErrorResponse } from '../api/response';

let activeProcessingRequests = 0;

export function getActiveProcessingCount(): number {
  return activeProcessingRequests;
}

export function resetActiveProcessingCount(): void {
  activeProcessingRequests = 0;
}

export function createConcurrencyGuard(config: AppConfig) {
  return function concurrencyGuardHook(
    request: FastifyRequest,
    reply: FastifyReply,
    done: () => void
  ): void {
    if (activeProcessingRequests >= config.maxConcurrentProcessing) {
      reply.header('Retry-After', '5');
      reply.status(503).send(
        formatErrorResponse(
          'SERVER_TOO_BUSY',
          `Server has reached its maximum concurrent document processing capacity (${config.maxConcurrentProcessing}). Please retry shortly.`,
          request.requestId || 'unknown'
        )
      );
      return;
    }

    activeProcessingRequests++;

    const decrement = () => {
      activeProcessingRequests = Math.max(0, activeProcessingRequests - 1);
    };

    reply.raw.once('finish', decrement);
    reply.raw.once('close', decrement);

    done();
  };
}
