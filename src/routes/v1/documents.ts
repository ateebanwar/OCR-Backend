import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DocumentProcessingService } from '../../services/DocumentProcessingService';
import { ChatService } from '../../services/ChatService';
import { formatSuccessResponse } from '../../api/response';
import { FileValidationError, ValidationError } from '../../errors/AppError';
import { AppConfig } from '../../config/env';
import { AIProvider } from '../../providers/ai/AIProvider';
import { createConcurrencyGuard } from '../../middleware/concurrencyGuard';
import { sanitizeFilename } from '../../security/fileValidator';

export interface DocumentRouteOptions {
  config: AppConfig;
  aiProvider: AIProvider;
}

const downloadBodySchema = z.object({
  xlsxBase64: z.string().min(10, 'Valid base64 XLSX content is required'),
  filename: z.string().max(100, 'Filename exceeds maximum length').optional().default('financial_report.xlsx'),
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

export const documentRoutes: FastifyPluginAsync<DocumentRouteOptions> = async (
  fastify: FastifyInstance,
  options
) => {
  const { config, aiProvider } = options;
  const processingService = new DocumentProcessingService(aiProvider, config);
  const chatService = new ChatService(aiProvider, config);
  const concurrencyGuard = createConcurrencyGuard(config);

  // POST /api/v1/documents/process
  fastify.post(
    '/documents/process',
    { preHandler: concurrencyGuard },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw new FileValidationError('Invalid content-type. Expected multipart/form-data.');
      }

      const data = await request.file();

      if (!data) {
        throw new FileValidationError('No file uploaded. Please upload a PDF file using multipart/form-data.');
      }

      if (data.file.truncated) {
        throw new FileValidationError('Uploaded file exceeds the maximum allowed size.');
      }

      const buffer = await data.toBuffer();
      if (!buffer || buffer.length === 0) {
        throw new FileValidationError('Uploaded file buffer is empty.');
      }

      const result = await processingService.processDocument(buffer, data.filename);
      return reply.status(200).send(formatSuccessResponse(result, request.requestId));
    }
  );

  // POST /api/v1/documents/download
  // Allows downloading the verified Excel workbook directly as a binary file
  fastify.post('/documents/download', async (request, reply) => {
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
  fastify.post('/documents/chat', async (request, reply) => {
    const parseResult = documentChatSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid document chat payload.', parseResult.error.errors);
    }

    const response = await chatService.chatWithDocument(parseResult.data);
    return reply.status(200).send(formatSuccessResponse(response, request.requestId));
  });
};
