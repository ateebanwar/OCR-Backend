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

  // Requirement 1 & 3: Local dev origins with OPTIONS preflight
  it('handles OPTIONS preflight from http://127.0.0.1:3000 on /api/v1/access/status with 204 and correct CORS headers', async () => {
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

  // Requirement 5: Test documents/process preflight and POST
  it('handles OPTIONS preflight on /api/v1/documents/process from http://127.0.0.1:3000 with 204', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/documents/process',
      headers: {
        origin: 'http://127.0.0.1:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  // Requirement 10: Error responses contain CORS headers
  it('preserves CORS headers on 400 error response from /api/v1/documents/process', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: {
        origin: 'http://127.0.0.1:3000',
        authorization: 'Bearer dummy-token',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  // Requirement 5: Test documents/download preflight
  it('handles OPTIONS preflight on /api/v1/documents/download from http://127.0.0.1:3000 with 204', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/documents/download',
      headers: {
        origin: 'http://127.0.0.1:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  // Requirement 5: Test documents/review preflight
  it('handles OPTIONS preflight on /api/v1/documents/review from http://127.0.0.1:3000 with 204', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/documents/review',
      headers: {
        origin: 'http://127.0.0.1:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  // Requirement 5: Test access/verify preflight
  it('handles OPTIONS preflight on /api/v1/access/verify from http://127.0.0.1:3000 with 204', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/access/verify',
      headers: {
        origin: 'http://127.0.0.1:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  // Requirement 1: Allow all local development origins
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

  // Requirement 2: Configurable production FRONTEND_ORIGIN
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

  // Requirement 7: Never wildcard * on authenticated production API
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
