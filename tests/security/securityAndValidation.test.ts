import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { loadConfig } from '../../src/config/env';
import { sanitizeFilename } from '../../src/security/fileValidator';
import { scrubString, scrubObject } from '../../src/security/scrubber';

describe('Security and Validation Safeguards', () => {
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

  it('rejects fake PDF that does not begin with %PDF magic bytes', async () => {
    const fakeContent = Buffer.from('THIS IS NOT A PDF FILE - JUST TEXT');
    const boundary = '----TestBoundary123';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fake.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      fakeContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });

    expect(res.statusCode).toBe(415);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNSUPPORTED_DOCUMENT_TYPE');
    expect(body.error.message).toContain('magic bytes');
  });

  it('rejects unsupported file extension (.exe)', async () => {
    const fakeContent = Buffer.from('%PDF-1.4\nvalid magic bytes');
    const boundary = '----TestBoundary123';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="malicious.exe"\r\nContent-Type: application/pdf\r\n\r\n`),
      fakeContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });

    expect(res.statusCode).toBe(415);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("Unsupported file extension '.exe'");
  });

  it('sanitizes path traversal attempts in filenames', () => {
    const malicious1 = '../../../../etc/passwd.pdf';
    const sanitized1 = sanitizeFilename(malicious1);
    expect(sanitized1).not.toContain('..');
    expect(sanitized1).not.toContain('/');
    expect(sanitized1).toBe('passwd.pdf');

    const malicious2 = '..\\..\\windows\\system32\\cmd.exe.pdf';
    const sanitized2 = sanitizeFilename(malicious2);
    expect(sanitized2).not.toContain('\\');
    expect(sanitized2).not.toContain('..');
  });

  it('scrubs API keys and secrets from strings and nested objects', () => {
    const rawApiKey = 'key-dummytestsecretkey1234567890abcdefgh';
    const scrubbed = scrubString(`Error accessing service with key ${rawApiKey}`);
    expect(scrubbed).not.toContain(rawApiKey);
    expect(scrubbed).toContain('[REDACTED_SECRET]');

    const sensitiveObj = {
      user: 'alice',
      geminiApiKey: 'test-gemini-api-key-placeholder-only',
      password: 'SuperSecretPassword',
      fileBuffer: Buffer.from('hello world'),
    };
    const cleaned = scrubObject(sensitiveObj) as Record<string, unknown>;
    expect(cleaned['geminiApiKey']).toBe('[REDACTED]');
    expect(cleaned['password']).toBe('[REDACTED]');
    expect(cleaned['fileBuffer']).toContain('[BUFFER');
  });

  it('propagates custom X-Request-ID header correctly', async () => {
    const customRequestId = 'req-trace-999888';
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: {
        'x-request-id': customRequestId,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe(customRequestId);
    const body = JSON.parse(res.body);
    expect(body.requestId).toBe(customRequestId);
  });
});
