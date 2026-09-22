import crypto from 'node:crypto';
import { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export function requestIdHook(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void
): void {
  const existingId = request.headers['x-request-id'];
  const requestId =
    typeof existingId === 'string' && existingId.length > 0
      ? existingId
      : crypto.randomUUID();

  request.requestId = requestId;
  reply.header('x-request-id', requestId);
  done();
}
