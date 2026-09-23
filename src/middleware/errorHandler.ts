import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors/AppError';
import { formatErrorResponse } from '../api/response';
import { scrubObject } from '../security/scrubber';
import { isOriginAllowed } from '../security/cors';
import { getConfig } from '../config/env';

export function globalErrorHandler(
  error: FastifyError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const requestId = request.requestId || 'unknown-request-id';

  // Ensure CORS headers are explicitly preserved on error responses (Req 10)
  const origin = request.headers.origin;
  if (origin) {
    try {
      const config = (request.server as any).config || getConfig();
      if (isOriginAllowed(origin, config)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Access-Control-Expose-Headers', 'X-Request-ID, Content-Disposition, Content-Type');
        reply.header('Vary', 'Origin');
      }
    } catch {
      // Fallback
    }
  }

  // Check if it is one of our typed AppError instances
  if (error instanceof AppError) {
    request.log.warn({
      requestId,
      errorCode: error.code,
      statusCode: error.statusCode,
      message: error.message,
      details: scrubObject(error.details),
    });

    reply.status(error.statusCode).send(
      formatErrorResponse(
        error.code,
        error.message,
        requestId,
        error.details ? scrubObject(error.details) : undefined
      )
    );
    return;
  }

  // Fastify native schema / validation errors
  const fastifyErr = error as FastifyError;
  if (fastifyErr.validation) {
    const message = fastifyErr.message || 'Request validation failed';
    reply.status(400).send(
      formatErrorResponse('REQUEST_VALIDATION_ERROR', message, requestId, fastifyErr.validation)
    );
    return;
  }

  if (fastifyErr.statusCode === 413 || fastifyErr.code === 'FST_REQ_FILE_TOO_LARGE') {
    reply.status(413).send(
      formatErrorResponse('FILE_TOO_LARGE', 'Uploaded file exceeds the maximum allowed size.', requestId)
    );
    return;
  }

  if (fastifyErr.statusCode === 429 || fastifyErr.code === 'FST_ERR_RATE_LIMIT_EXCEEDED' || fastifyErr.code === 'RATE_LIMIT_EXCEEDED') {
    reply.status(429).send(
      formatErrorResponse('RATE_LIMIT_EXCEEDED', fastifyErr.message || 'Rate limit exceeded. Please retry later.', requestId)
    );
    return;
  }

  // Fallback for unexpected internal errors
  const isDev = process.env.NODE_ENV === 'development';
  request.log.error({
    requestId,
    name: error.name,
    message: error.message,
    stack: isDev ? error.stack : undefined,
  });

  const statusCode = fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 600
    ? fastifyErr.statusCode
    : 500;

  let errorCode = 'INTERNAL_SERVER_ERROR';
  if (statusCode === 400) errorCode = 'BAD_REQUEST';
  else if (statusCode === 404) errorCode = 'NOT_FOUND';
  else if (statusCode === 415) errorCode = 'UNSUPPORTED_MEDIA_TYPE';
  else if (statusCode === 502) errorCode = 'BAD_GATEWAY';
  else if (statusCode === 504) errorCode = 'GATEWAY_TIMEOUT';

  const userMessage = statusCode === 500 && !isDev
    ? 'An internal error occurred while processing the request.'
    : error.message;

  reply.status(statusCode).send(
    formatErrorResponse(
      errorCode,
      userMessage,
      requestId
    )
  );
}
