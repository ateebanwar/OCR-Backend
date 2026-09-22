import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { loadConfig } from '../../src/config/env';

describe('Health and Chat API Endpoints', () => {
  let app: FastifyInstance;
  let mockAi: MockAIProvider;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      PORT: '3001',
    });
    mockAi = new MockAIProvider();
    app = await buildApp({ config, aiProvider: mockAi });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns 200 with service health info', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('healthy');
    expect(body.data.environment).toBe('test');
    expect(body.requestId).toBeDefined();
    // Verify no secret leak
    expect(response.body).not.toContain('API_KEY');
    expect(response.body).not.toContain('secret');
  });

  it('POST /api/v1/chat returns 200 with AI response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: {
        messages: [{ role: 'user', content: 'What is EBITDA?' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.content).toContain('Mock AI response to: What is EBITDA?');
    expect(body.requestId).toBeDefined();
  });

  it('POST /api/v1/chat with stream: true returns SSE event stream', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: {
        messages: [{ role: 'user', content: 'Explain depreciation' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: ');
    expect(response.body).toContain('[DONE]');
  });

  it('POST /api/v1/documents/chat returns contextual response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/chat',
      payload: {
        documentContext: 'Invoice #100 for $500 from Vendor X',
        messages: [{ role: 'user', content: 'Who is the vendor?' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.role).toBe('assistant');
  });
});
