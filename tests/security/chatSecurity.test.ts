import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { loadConfig } from '../../src/config/env';

describe('Chat API Security & Input Bounds', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      PORT: '3001',
    });
    app = await buildApp({ config, aiProvider: new MockAIProvider() });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects chat messages exceeding 4,000 character limit', async () => {
    const hugeMessage = 'A'.repeat(4005);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: {
        messages: [{ role: 'user', content: hugeMessage }],
      },
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(body.error.details)).toContain('Message content exceeds 4,000 characters limit');
  });

  it('rejects chat conversations with excessive history (> 30 messages)', async () => {
    const excessiveMessages = Array.from({ length: 35 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i + 1}`,
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: {
        messages: excessiveMessages,
      },
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(JSON.stringify(body.error.details)).toContain('Conversation history cannot exceed 30 messages');
  });

  it('rejects document chat requests with context exceeding 50,000 characters', async () => {
    const oversizedContext = 'Context '.repeat(10000); // 80,000 chars
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/chat',
      payload: {
        documentContext: oversizedContext,
        messages: [{ role: 'user', content: 'What is the total?' }],
      },
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(JSON.stringify(body.error.details)).toContain('50,000 characters');
  });
});
