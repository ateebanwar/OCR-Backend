import { describe, it, expect, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { loadConfig } from '../../src/config/env';

describe('HTTP Security Headers and Rate Limiting', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('sets required HTTP security headers (Helmet)', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      PORT: '3001',
    });
    app = await buildApp({ config, aiProvider: new MockAIProvider() });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('enforces rate limiting when requests exceed configured threshold', async () => {
    // Configure tight rate limit: max 2 requests per 60s
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      PORT: '3002',
      RATE_LIMIT_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    const rateLimitApp = await buildApp({ config, aiProvider: new MockAIProvider() });
    await rateLimitApp.ready();

    // Request 1: 200 OK
    const res1 = await rateLimitApp.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res1.statusCode).toBe(200);

    // Request 2: 200 OK
    const res2 = await rateLimitApp.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res2.statusCode).toBe(200);

    // Request 3: 429 Too Many Requests
    const res3 = await rateLimitApp.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res3.statusCode).toBe(429);
    const body = JSON.parse(res3.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');

    await rateLimitApp.close();
  });
});
