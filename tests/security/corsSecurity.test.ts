import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { loadConfig } from '../../src/config/env';

describe('CORS & Preflight Security Verification', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      REQUIRE_PASSWORD: 'false',
      FRONTEND_ORIGIN: 'https://production-frontend.com',
      ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000',
    });
    app = await buildApp({ config });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('handles OPTIONS preflight from http://127.0.0.1:3000 with 204 and correct CORS headers', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/access/status',
      headers: {
        origin: 'http://127.0.0.1:3000',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type,authorization,x-request-id',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBeDefined();
  });

  it('allows http://localhost:3000, http://localhost:5173, and http://127.0.0.1:5173', async () => {
    const origins = [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ];

    for (const origin of origins) {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/access/status',
        headers: {
          origin,
          'access-control-request-method': 'GET',
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    }
  });

  it('allows configurable production FRONTEND_ORIGIN', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/access/status',
      headers: {
        origin: 'https://production-frontend.com',
        'access-control-request-method': 'GET',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://production-frontend.com');
  });

  it('never uses wildcard "*" for allowed origin on authenticated endpoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/access/status',
      headers: {
        origin: 'http://127.0.0.1:3000',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('does not send Access-Control-Allow-Origin for untrusted/malicious origins and does not crash with 500', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/access/status',
      headers: {
        origin: 'http://malicious-third-party.evil.com',
        'access-control-request-method': 'GET',
      },
    });

    expect(res.statusCode).not.toBe(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests with no Origin header (curl, mobile, server-side)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/access/status',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
  });
});
