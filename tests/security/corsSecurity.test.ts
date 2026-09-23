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
      FRONTEND_ORIGIN: 'https://ocr-front-end-iota.vercel.app',
      ALLOWED_ORIGINS: 'https://ocr-front-end-iota.vercel.app,http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000',
    });
    app = await buildApp({ config });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Verify production Vercel frontend origin: https://ocr-front-end-iota.vercel.app
  it('handles OPTIONS preflight from https://ocr-front-end-iota.vercel.app on /api/v1/access/status with 204 and correct CORS headers', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/access/status',
      headers: {
        origin: 'https://ocr-front-end-iota.vercel.app',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'content-type,authorization,x-request-id',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://ocr-front-end-iota.vercel.app');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBeDefined();
  });

  it('handles GET /api/v1/access/status from https://ocr-front-end-iota.vercel.app with 200 and matching CORS header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/access/status',
      headers: {
        origin: 'https://ocr-front-end-iota.vercel.app',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://ocr-front-end-iota.vercel.app');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('handles OPTIONS preflight from https://ocr-front-end-iota.vercel.app on /api/v1/documents/process with 204', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/documents/process',
      headers: {
        origin: 'https://ocr-front-end-iota.vercel.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://ocr-front-end-iota.vercel.app');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  // Local development origins
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

  it('allows Vercel preview deployment URLs matching VERCEL_FRONTEND_REGEX', async () => {
    const previewOrigins = [
      'https://ocr-front-end-git-main-ateebanwar.vercel.app',
      'https://ocr-frontend-preview.vercel.app',
    ];

    for (const origin of previewOrigins) {
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
    }
  });

  it('preserves CORS headers on 400 error response from /api/v1/documents/process', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: {
        origin: 'https://ocr-front-end-iota.vercel.app',
        authorization: 'Bearer dummy-token',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['access-control-allow-origin']).toBe('https://ocr-front-end-iota.vercel.app');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('handles OPTIONS preflight on /api/v1/documents/download with 204', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/documents/download',
      headers: {
        origin: 'https://ocr-front-end-iota.vercel.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://ocr-front-end-iota.vercel.app');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('never uses wildcard "*" for allowed origin on authenticated endpoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/access/status',
      headers: {
        origin: 'https://ocr-front-end-iota.vercel.app',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://ocr-front-end-iota.vercel.app');
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
