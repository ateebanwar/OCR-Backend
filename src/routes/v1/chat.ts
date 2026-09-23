import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ChatService } from '../../services/ChatService';
import { formatSuccessResponse } from '../../api/response';
import { ValidationError } from '../../errors/AppError';
import { AppConfig } from '../../config/env';
import { AIProvider } from '../../providers/ai/AIProvider';
import { createAuthGuard } from '../../middleware/authGuard';

export interface ChatRouteOptions {
  config: AppConfig;
  aiProvider: AIProvider;
}

const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z
          .string()
          .min(1, 'Message content cannot be empty')
          .max(4000, 'Message content exceeds 4,000 characters limit'),
      })
    )
    .min(1, 'At least one message is required')
    .max(30, 'Conversation history cannot exceed 30 messages'),
  model: z.string().max(100, 'Model name exceeds maximum length').optional(),
  stream: z.boolean().optional().default(false),
});

export const chatRoutes: FastifyPluginAsync<ChatRouteOptions> = async (
  fastify: FastifyInstance,
  options
) => {
  const { config, aiProvider } = options;
  const chatService = new ChatService(aiProvider, config);
  const authGuard = createAuthGuard(config);

  fastify.post('/chat', { preHandler: authGuard }, async (request, reply) => {
    const parseResult = chatBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid chat request payload.', parseResult.error.errors);
    }

    const { messages, model, stream } = parseResult.data;

    if (stream) {
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Request-ID', request.requestId);

      try {
        const streamGenerator = chatService.streamChat(messages, model);
        for await (const chunk of streamGenerator) {
          reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } catch (err: unknown) {
        const errPayload = JSON.stringify({
          error: err instanceof Error ? err.message : 'Streaming error occurred',
        });
        reply.raw.write(`data: ${errPayload}\n\n`);
        reply.raw.end();
      }
      return reply;
    }

    const response = await chatService.chat(messages, model);
    return reply.status(200).send(formatSuccessResponse(response, request.requestId));
  });
};
