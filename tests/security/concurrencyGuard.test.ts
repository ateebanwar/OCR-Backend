import { describe, it, expect, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { loadConfig } from '../../src/config/env';
import { resetActiveProcessingCount } from '../../src/middleware/concurrencyGuard';

describe('Concurrency & Resource Guard (CWE-400)', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    resetActiveProcessingCount();
    if (app) {
      await app.close();
    }
  });

  it('rejects processing requests with 503 SERVER_TOO_BUSY when concurrency limit is exceeded', async () => {
    // Configure maxConcurrentProcessing to 1
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      PORT: '3003',
      MAX_CONCURRENT_PROCESSING: '1',
    });

    const slowMock = new MockAIProvider();
    // Simulate slow async AI call to hold concurrency active
    slowMock.extractStructuredData = async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return slowMock.mockExtractionData as unknown as any;
    };

    app = await buildApp({ config, aiProvider: slowMock });
    await app.ready();

    const validPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
    );

    const boundary = '----ConcurrencyBoundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      validPdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    // Send Request 1 (occupies the slot for 300ms)
    const req1Promise = app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    // Wait 20ms to ensure request 1 enters preHandler and increments active counter
    await new Promise(resolve => setTimeout(resolve, 20));

    // Send Request 2 (should be rejected with 503)
    const req2 = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(req2.statusCode).toBe(503);
    const body2 = JSON.parse(req2.body);
    expect(body2.success).toBe(false);
    expect(body2.error.code).toBe('SERVER_TOO_BUSY');
    expect(req2.headers['retry-after']).toBe('5');

    // Wait for Request 1 to complete
    const req1 = await req1Promise;
    expect(req1.statusCode).toBe(200);

    resetActiveProcessingCount();
  });
});
