import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { loadConfig } from '../../src/config/env';

describe('Document Processing API Pipeline', () => {
  let app: FastifyInstance;
  let mockAi: MockAIProvider;

  const validPdfContent = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
  );

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

  it('POST /api/v1/documents/process processes valid PDF through full pipeline and outputs verified XLSX', async () => {
    const boundary = '----TestBoundary12345';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="invoice-test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      validPdfContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

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
    expect(body.data.documentHash).toBeDefined();
    expect(body.data.isVerified).toBe(true);
    expect(body.data.document.vendor.name).toBe('Acme Cloud Technologies Inc.');
    expect(body.data.reconciliation.overallStatus).toBe('EXACT_MATCH');
    expect(body.data.xlsxBase64).toBeDefined();
    expect(body.data.xlsxVerification.isValid).toBe(true);
    expect(body.data.xlsxVerification.sheetNames).toContain('Document Summary');
    expect(body.data.xlsxVerification.sheetNames).toContain('Line Items');
    expect(body.data.auditTrail.stages.length).toBeGreaterThanOrEqual(5);
  });

  it('POST /api/v1/documents/download returns valid binary XLSX attachment', async () => {
    // Generate valid base64 via first request
    const boundary = '----TestBoundary12345';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      validPdfContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const procRes = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });
    const procData = JSON.parse(procRes.body).data;

    const downloadRes = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/download',
      payload: {
        xlsxBase64: procData.xlsxBase64,
        filename: 'monthly_invoice.xlsx',
      },
    });

    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(downloadRes.headers['content-disposition']).toContain('attachment; filename="monthly_invoice.xlsx"');
    expect(downloadRes.rawPayload.length).toBeGreaterThan(1000);
  });

  it('returns 200 with REVIEW_REQUIRED and reviewToken when financial reconciliation has unresolved discrepancies on processable document', async () => {
    // Configure mock to return conflicting data
    const corruptedAi = new MockAIProvider();
    corruptedAi.mockExtractionData = {
      ...corruptedAi.mockExtractionData,
      totals: {
        ...corruptedAi.mockExtractionData.totals,
        grandTotal: 99999.0, // blatant unresolvable discrepancy
      },
    };

    const localConfig = loadConfig({ NODE_ENV: 'test', AI_PROVIDER: 'mock' });
    const localApp = await buildApp({ config: localConfig, aiProvider: corruptedAi });
    await localApp.ready();

    const boundary = '----TestBoundary12345';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="corrupted.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      validPdfContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await localApp.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.isVerified).toBe(false);
    expect(body.data.summary.status).toBe('REVIEW_REQUIRED');
    expect(body.data.summary.review.required).toBe(true);
    expect(body.data.summary.review.reviewToken).toBeDefined();
    expect(body.data.reconciliation.isVerified).toBe(false);

    await localApp.close();
  });
});
