import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DocumentProcessingService } from '../../services/DocumentProcessingService';
import { ChatService } from '../../services/ChatService';
import { DocumentInputResolver } from '../../services/DocumentInputResolver';
import { BlobStorageService } from '../../services/BlobStorageService';
import { formatSuccessResponse } from '../../api/response';
import { FileValidationError, ValidationError } from '../../errors/AppError';
import { AppConfig } from '../../config/env';
import { AIProvider } from '../../providers/ai/AIProvider';
import { createConcurrencyGuard } from '../../middleware/concurrencyGuard';
import { createAuthGuard } from '../../middleware/authGuard';
import { sanitizeFilename } from '../../security/fileValidator';

export interface DocumentRouteOptions {
  config: AppConfig;
  aiProvider: AIProvider;
  blobStorageService?: BlobStorageService;
}

const downloadBodySchema = z.object({
  xlsxBase64: z.string().min(10, 'Valid base64 XLSX content is required'),
  filename: z.string().max(100, 'Filename exceeds maximum length').optional().default('financial_report.xlsx'),
});

const uploadTokenBodySchema = z.object({
  filename: z.string().max(255).optional().default('document.pdf'),
});

const documentChatSchema = z.object({
  documentContext: z.string().min(1, 'documentContext is required').max(50000, 'documentContext exceeds maximum length of 50,000 characters'),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string().min(1, 'Message content cannot be empty').max(4000, 'Message exceeds 4,000 characters limit'),
    })
  ).min(1, 'At least one chat message is required').max(30, 'Conversation history cannot exceed 30 messages'),
  model: z.string().optional(),
});

const reviewResolutionSchema = z.object({
  reviewToken: z.string().min(1, 'reviewToken is required'),
  resolutions: z
    .array(
      z.object({
        issueId: z.string().min(1, 'issueId is required'),
        userDecision: z.enum([
          'DISCOUNT',
          'CREDIT',
          'REFUND',
          'ADJUSTMENT',
          'OTHER',
          'KEEP_AS_IS',
        ]),
        customMeaning: z.string().max(500).nullable().optional(),
        customValue: z.unknown().optional(),
      })
    )
    .min(1, 'At least one resolution is required'),
});

export const documentRoutes: FastifyPluginAsync<DocumentRouteOptions> = async (
  fastify: FastifyInstance,
  options
) => {
  const { config, aiProvider, blobStorageService } = options;
  const processingService = new DocumentProcessingService(aiProvider, config);
  const chatService = new ChatService(aiProvider, config);
  const blobService = blobStorageService || new BlobStorageService(config);
  const inputResolver = new DocumentInputResolver(config, blobService);
  const concurrencyGuard = createConcurrencyGuard(config);
  const authGuard = createAuthGuard(config);

  // POST /api/v1/documents/upload-token
  // Issues an authorized, controlled client token for direct private Vercel Blob uploads
  fastify.post(
    '/documents/upload-token',
    {
      preHandler: authGuard,
      config: {
        rateLimit: {
          max: config.rateLimitMax,
          timeWindow: config.rateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      // Check if request is official @vercel/blob/client handleUpload event
      const body = request.body as Record<string, unknown> | undefined;
      if (body && typeof body === 'object' && typeof body['type'] === 'string' && body['type'].startsWith('blob.')) {
        const clientUploadRes = await blobService.handleClientUpload(request, body as any);
        return reply.status(200).send(clientUploadRes);
      }

      const parseResult = uploadTokenBodySchema.safeParse(request.body || {});
      if (!parseResult.success) {
        throw new ValidationError('Invalid upload-token payload.', parseResult.error.errors);
      }

      const result = await blobService.generateUploadToken(parseResult.data.filename);
      return reply.status(200).send(formatSuccessResponse(result, request.requestId));
    }
  );

  // POST /api/v1/documents/process
  // Supports both direct multipart uploads and private Vercel Blob references seamlessly
  fastify.post(
    '/documents/process',
    { preHandler: [authGuard, concurrencyGuard] },
    async (request, reply) => {
      const input = await inputResolver.resolveInput(request);
      try {
        const result = await processingService.processDocument(input.buffer, input.filename);
        if (input.cleanup) {
          try {
            await input.cleanup();
          } catch (e) {
            request.log.warn({ err: e }, 'Error during input cleanup');
          }
        }
        return reply.status(200).send(formatSuccessResponse(result, request.requestId));
      } catch (err) {
        if (input.cleanup) {
          try {
            await input.cleanup();
          } catch (e) {
            request.log.warn({ err: e }, 'Error during input cleanup on error');
          }
        }
        throw err;
      }
    }
  );

  // POST /api/v1/documents/review
  fastify.post('/documents/review', { preHandler: authGuard }, async (request, reply) => {
    const parseResult = reviewResolutionSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid document review payload.', parseResult.error.errors);
    }

    const reviewService = processingService.getReviewResolutionService();
    const result = await reviewService.resolveReview(parseResult.data);
    return reply.status(200).send(formatSuccessResponse(result, request.requestId));
  });

  // POST /api/v1/documents/download
  // Allows downloading the verified Excel workbook directly as a binary file
  fastify.post('/documents/download', { preHandler: authGuard }, async (request, reply) => {
    const parseResult = downloadBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid download request payload.', parseResult.error.errors);
    }

    const { xlsxBase64, filename } = parseResult.data;
    const sanitizedBase = sanitizeFilename(filename);
    const cleanFilename = sanitizedBase.endsWith('.xlsx') ? sanitizedBase : `${sanitizedBase}.xlsx`;
    const buffer = Buffer.from(xlsxBase64, 'base64');

    reply.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    reply.header('Content-Disposition', `attachment; filename="${cleanFilename}"`);
    return reply.status(200).send(buffer);
  });

  // POST /api/v1/documents/chat
  fastify.post('/documents/chat', { preHandler: authGuard }, async (request, reply) => {
    const parseResult = documentChatSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid document chat payload.', parseResult.error.errors);
    }

    const response = await chatService.chatWithDocument(parseResult.data);
    return reply.status(200).send(formatSuccessResponse(response, request.requestId));
  });
};
