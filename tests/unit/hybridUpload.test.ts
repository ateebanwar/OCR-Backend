import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { loadConfig } from '../../src/config/env';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { BlobStorageService, BlobStorageAdapter } from '../../src/services/BlobStorageService';
import { DocumentProcessingService } from '../../src/services/DocumentProcessingService';
import { DocumentProcessingError } from '../../src/errors/AppError';

describe('Hybrid PDF Upload & Transport Layer Suite', () => {
  let app: FastifyInstance;
  let mockAi: MockAIProvider;
  let mockBlobAdapter: MockBlobAdapter;
  let blobService: BlobStorageService;

  const validPdfContent = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
  );

  class MockBlobAdapter implements BlobStorageAdapter {
    public storage: Map<string, { buffer: Buffer; access: string; contentType: string }> = new Map();
    public deletedPaths: string[] = [];
    public failDeletions: boolean = false;

    async get(pathname: string, options: { access: 'private'; token?: string; useCache?: boolean }) {
      const item = this.storage.get(pathname);
      if (!item) {
        return null;
      }

      // Convert Buffer to ReadableStream<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(item.buffer));
          controller.close();
        },
      });

      return {
        statusCode: 200,
        stream,
        blob: {
          pathname,
          size: item.buffer.length,
          contentType: item.contentType,
        },
      };
    }

    async del(urlOrPathname: string | string[]) {
      if (this.failDeletions) {
        throw new Error('Simulated Vercel Blob deletion service failure');
      }
      const paths = Array.isArray(urlOrPathname) ? urlOrPathname : [urlOrPathname];
      for (const p of paths) {
        this.deletedPaths.push(p);
        this.storage.delete(p);
      }
    }

    async head(pathname: string) {
      const item = this.storage.get(pathname);
      if (!item) throw new Error('Not found');
      return {
        size: item.buffer.length,
        pathname,
        contentType: item.contentType,
      };
    }

    async generateClientToken(options: any) {
      return `mock-client-token-for-${options.pathname}`;
    }
  }

  const createMultipartPayload = (filename: string, content: Buffer) => {
    const boundary = '----HybridUploadTestBoundary';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { boundary, multipartBody };
  };

  beforeEach(async () => {
    mockAi = new MockAIProvider();
    mockBlobAdapter = new MockBlobAdapter();
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      MAX_UPLOAD_SIZE_MB: '25',
      DIRECT_UPLOAD_MAX_MB: '4',
      BLOB_READ_WRITE_TOKEN: 'mock_blob_token_for_test',
    });

    blobService = new BlobStorageService(config, mockBlobAdapter);
    app = await buildApp({ config, aiProvider: mockAi, blobStorageService: blobService });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('1. Mode A: Direct Multipart Path (<= 4 MB threshold)', () => {
    it('processes small 1 MB PDF directly through multipart without touching Blob storage', async () => {
      // 1 MB dummy PDF
      const oneMbPdf = Buffer.concat([validPdfContent, Buffer.alloc(1024 * 1024 - validPdfContent.length, 32)]);
      const { boundary, multipartBody } = createMultipartPayload('invoice-1mb.pdf', oneMbPdf);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.documentId).toBeDefined();
      expect(body.data.xlsxBase64).toBeDefined();
      // Zero interaction with Blob storage
      expect(mockBlobAdapter.storage.size).toBe(0);
      expect(mockBlobAdapter.deletedPaths.length).toBe(0);
    });

    it('processes 3 MB PDF directly through multipart', async () => {
      const threeMbPdf = Buffer.concat([validPdfContent, Buffer.alloc(3 * 1024 * 1024 - validPdfContent.length, 32)]);
      const { boundary, multipartBody } = createMultipartPayload('invoice-3mb.pdf', threeMbPdf);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('processes 4 MB PDF directly through multipart (safe threshold boundary)', async () => {
      const fourMbPdf = Buffer.concat([validPdfContent, Buffer.alloc(4 * 1024 * 1024 - validPdfContent.length, 32)]);
      const { boundary, multipartBody } = createMultipartPayload('invoice-4mb.pdf', fourMbPdf);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });
  });

  describe('2. Mode B: Private Vercel Blob Path (> 4 MB up to 25 MB)', () => {
    it('POST /api/v1/documents/upload-token generates controlled namespaced pathname and client token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/upload-token',
        payload: { filename: 'Large-Annual-Report-2026.pdf' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.clientToken).toBeDefined();
      expect(body.data.blobPathname).toMatch(/^ocr-intelligence\/uploads\/[0-9a-fA-F-]{36}\/Large-Annual-Report-2026\.pdf$/);
      expect(body.data.maxSizeBytes).toBe(25 * 1024 * 1024);
      expect(body.data.allowedContentTypes).toContain('application/pdf');

      // Never leak secrets
      expect(res.body).not.toContain('mock_blob_token_for_test');
    });

    it('processes 5 MB PDF via Private Blob reference, converges into existing pipeline, and deletes source blob', async () => {
      const fiveMbPdf = Buffer.concat([validPdfContent, Buffer.alloc(5 * 1024 * 1024 - validPdfContent.length, 32)]);
      const { pathname } = blobService.generateControlledPathname('complex-5mb.pdf');

      // Store in private blob mock
      mockBlobAdapter.storage.set(pathname, {
        buffer: fiveMbPdf,
        access: 'private',
        contentType: 'application/pdf',
      });
      expect(mockBlobAdapter.storage.has(pathname)).toBe(true);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: {
          blobPathname: pathname,
          filename: 'complex-5mb.pdf',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.documentId).toBeDefined();
      expect(body.data.isVerified).toBe(true);
      expect(body.data.xlsxBase64).toBeDefined();
      expect(body.data.summary.status).toBe('VERIFIED');

      // Immediate Lifecycle Cleanup: Source Blob MUST be deleted immediately
      expect(mockBlobAdapter.storage.has(pathname)).toBe(false);
      expect(mockBlobAdapter.deletedPaths).toContain(pathname);
    });

    it('processes 20 MB PDF via Private Blob reference successfully', async () => {
      const twentyMbPdf = Buffer.concat([validPdfContent, Buffer.alloc(20 * 1024 * 1024 - validPdfContent.length, 32)]);
      const { pathname } = blobService.generateControlledPathname('statement-20mb.pdf');

      mockBlobAdapter.storage.set(pathname, {
        buffer: twentyMbPdf,
        access: 'private',
        contentType: 'application/pdf',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: pathname },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(mockBlobAdapter.deletedPaths).toContain(pathname);
    });

    it('processes exactly 25 MB PDF via Private Blob reference successfully', async () => {
      const twentyFiveMbPdf = Buffer.concat([validPdfContent, Buffer.alloc(25 * 1024 * 1024 - validPdfContent.length, 32)]);
      const { pathname } = blobService.generateControlledPathname('exact-25mb.pdf');

      mockBlobAdapter.storage.set(pathname, {
        buffer: twentyFiveMbPdf,
        access: 'private',
        contentType: 'application/pdf',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: pathname },
      });

      expect(response.statusCode).toBe(200);
      expect(mockBlobAdapter.deletedPaths).toContain(pathname);
    });

    it('rejects PDF larger than 25 MB (25 MB + 1 byte) during streaming download and cleans up source blob', async () => {
      const oversizedPdf = Buffer.concat([validPdfContent, Buffer.alloc(25 * 1024 * 1024 + 1 - validPdfContent.length, 32)]);
      const { pathname } = blobService.generateControlledPathname('oversized-25mb-plus.pdf');

      mockBlobAdapter.storage.set(pathname, {
        buffer: oversizedPdf,
        access: 'private',
        contentType: 'application/pdf',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: pathname },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FILE_VALIDATION_ERROR');
      expect(body.error.message).toContain('maximum allowed size of 25MB');

      // Crucial: Source Blob MUST be cleaned up even on size rejection!
      expect(mockBlobAdapter.storage.has(pathname)).toBe(false);
      expect(mockBlobAdapter.deletedPaths).toContain(pathname);
    });
  });

  describe('3. Security, SSRF & Path Traversal Protections', () => {
    it('rejects arbitrary external URLs to prevent SSRF', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: 'https://attacker.example.com/evil.pdf' },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('FILE_VALIDATION_ERROR');
      expect(body.error.message).toContain('controlled PDF upload namespace');
    });

    it('rejects path traversal attempts (..) in blobPathname', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: 'ocr-intelligence/uploads/../../../etc/passwd.pdf' },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('FILE_VALIDATION_ERROR');
    });

    it('rejects non-namespaced paths or non-PDF files', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: 'other-folder/secret.pdf' },
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: 'ocr-intelligence/uploads/12345678-1234-1234-1234-123456789abc/script.exe' },
      });
      expect(res2.statusCode).toBe(400);
    });

    it('returns 400 when referenced blob does not exist in store', async () => {
      const { pathname } = blobService.generateControlledPathname('missing.pdf');
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: pathname },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('FILE_VALIDATION_ERROR');
      expect(body.error.message).toContain('Referenced blob was not found');
    });
  });

  describe('4. Lifecycle Cleanup on Failure Scenarios', () => {
    it('deletes source blob when PDF validation fails (corrupt / invalid PDF bytes)', async () => {
      const corruptBytes = Buffer.from('NOT A REAL PDF FILE CONTENT');
      const { pathname } = blobService.generateControlledPathname('corrupt.pdf');

      mockBlobAdapter.storage.set(pathname, {
        buffer: corruptBytes,
        access: 'private',
        contentType: 'application/pdf',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: pathname },
      });

      expect(response.statusCode).toBe(415); // UNSUPPORTED_DOCUMENT_TYPE
      expect(mockBlobAdapter.storage.has(pathname)).toBe(false);
      expect(mockBlobAdapter.deletedPaths).toContain(pathname);
    });

    it('deletes source blob when processing throws an unexpected error', async () => {
      const spy = vi
        .spyOn(DocumentProcessingService.prototype, 'processDocument')
        .mockRejectedValueOnce(new DocumentProcessingError('Simulated unexpected fatal crash'));

      const { pathname } = blobService.generateControlledPathname('fatal-failure.pdf');
      mockBlobAdapter.storage.set(pathname, {
        buffer: validPdfContent,
        access: 'private',
        contentType: 'application/pdf',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: pathname },
      });

      expect(response.statusCode).toBe(422);
      expect(mockBlobAdapter.storage.has(pathname)).toBe(false);
      expect(mockBlobAdapter.deletedPaths).toContain(pathname);
      spy.mockRestore();
    });

    it('safely tolerates and logs when blob deletion itself fails without masking errors', async () => {
      mockBlobAdapter.failDeletions = true;
      const { pathname } = blobService.generateControlledPathname('delete-fail.pdf');

      mockBlobAdapter.storage.set(pathname, {
        buffer: validPdfContent,
        access: 'private',
        contentType: 'application/pdf',
      });

      // Processing still completes 200 without throwing an unhandled exception
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: { 'content-type': 'application/json' },
        payload: { blobPathname: pathname },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });
  });

  describe('5. Authentication & Status Endpoint', () => {
    it('GET /api/v1/access/status safely exposes uploadConfig thresholds', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/access/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.uploadConfig).toBeDefined();
      expect(body.data.uploadConfig.directUploadMaxBytes).toBe(4 * 1024 * 1024);
      expect(body.data.uploadConfig.maxUploadSizeBytes).toBe(25 * 1024 * 1024);
    });

    it('requires Bearer token on POST /api/v1/documents/upload-token when REQUIRE_PASSWORD=true', async () => {
      const authConfig = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: 'SecretPassword2026',
        ACCESS_TOKEN_SECRET: 'test-signing-secret-32-chars-long!',
        BLOB_READ_WRITE_TOKEN: 'mock_blob_token_for_test',
      });
      const authApp = await buildApp({
        config: authConfig,
        aiProvider: mockAi,
        blobStorageService: new BlobStorageService(authConfig, mockBlobAdapter),
      });
      await authApp.ready();

      // Without auth -> 401
      const resNoAuth = await authApp.inject({
        method: 'POST',
        url: '/api/v1/documents/upload-token',
        payload: { filename: 'test.pdf' },
      });
      expect(resNoAuth.statusCode).toBe(401);

      // Authenticate
      const authRes = await authApp.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: { password: 'SecretPassword2026' },
      });
      const token = JSON.parse(authRes.body).data.accessToken;

      // With auth -> 200
      const resWithAuth = await authApp.inject({
        method: 'POST',
        url: '/api/v1/documents/upload-token',
        headers: { authorization: `Bearer ${token}` },
        payload: { filename: 'test.pdf' },
      });
      expect(resWithAuth.statusCode).toBe(200);

      await authApp.close();
    });

    it('defensively sanitizes surrounding quotes and assignment prefixes in BLOB_READ_WRITE_TOKEN', () => {
      const configWithQuotes = loadConfig({
        NODE_ENV: 'test',
        BLOB_READ_WRITE_TOKEN: '"vercel_blob_rw_test_token_123"',
      });
      expect(configWithQuotes.blobReadWriteToken).toBe('vercel_blob_rw_test_token_123');

      const configWithPrefix = loadConfig({
        NODE_ENV: 'test',
        BLOB_READ_WRITE_TOKEN: 'BLOB_READ_WRITE_TOKEN="vercel_blob_rw_test_token_456"',
      });
      expect(configWithPrefix.blobReadWriteToken).toBe('vercel_blob_rw_test_token_456');

      const configWithNewline = loadConfig({
        NODE_ENV: 'test',
        BLOB_READ_WRITE_TOKEN: 'BLOB_READ_WRITE_TOKEN=\n"vercel_blob_rw_test_token_789"',
      });
      expect(configWithNewline.blobReadWriteToken).toBe('vercel_blob_rw_test_token_789');

      const service = new BlobStorageService(configWithNewline, mockBlobAdapter);
      expect((service as any).getToken()).toBe('vercel_blob_rw_test_token_789');
    });
  });
});
