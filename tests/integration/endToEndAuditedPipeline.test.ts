import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { loadConfig } from '../../src/config/env';
import { ProviderError, ProviderTimeoutError } from '../../src/errors/AppError';
import ExcelJS from 'exceljs';

describe('Comprehensive End-to-End Audited Backend Verification', () => {
  let app: FastifyInstance;
  let mockAi: MockAIProvider;

  const validPdfContent = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
  );

  const createMultipartPayload = (
    filename: string,
    content: Buffer,
    boundary = '----E2EBoundary7890'
  ) => {
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      payload: Buffer.concat([head, content, tail]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  };

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      PORT: '3001',
      MAX_UPLOAD_SIZE_MB: '1', // 1MB for tight limit testing
      MAX_PDF_PAGES: '5',
    });
    mockAi = new MockAIProvider();
    app = await buildApp({ config, aiProvider: mockAi });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. COMPLETE REAL FLOW
  it('E2E Flow: Valid PDF upload -> validation -> extraction -> reconciliation -> verification -> XLSX generation & download', async () => {
    const { payload, contentType } = createMultipartPayload('corporate-invoice.pdf', validPdfContent);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Extraction, validation, and reconciliation checks
    expect(body.data.documentId).toBeDefined();
    expect(body.data.documentHash).toHaveLength(64);
    expect(body.data.isVerified).toBe(true);
    expect(body.data.document.vendor.name).toBe('Acme Cloud Technologies Inc.');
    expect(body.data.reconciliation.overallStatus).toBe('EXACT_MATCH');
    expect(body.data.reconciliation.discrepancies).toHaveLength(0);

    // XLSX verification check
    expect(body.data.xlsxVerification.isValid).toBe(true);
    expect(body.data.xlsxVerification.sheetNames).toEqual(
      expect.arrayContaining(['Document Summary', 'Line Items', 'Reconciliation & Audit'])
    );
    expect(body.data.xlsxBase64).toBeDefined();

    // Now test downloading the final .xlsx response
    const downloadRes = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/download',
      payload: {
        xlsxBase64: body.data.xlsxBase64,
        filename: 'final_verified_report.xlsx',
      },
    });

    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(downloadRes.headers['content-disposition']).toContain('attachment; filename="final_verified_report.xlsx"');

    // Parse the binary Excel output to verify workbook integrity
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      downloadRes.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]
    );
    expect(workbook.worksheets.length).toBeGreaterThanOrEqual(3);
    const summarySheet = workbook.getWorksheet('Document Summary');
    expect(summarySheet).toBeDefined();
  });

  // 2. HEALTH ENDPOINT
  it('Health Check: GET /api/v1/health returns 200 with service health info and no leaked secrets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('healthy');
    expect(body.data.environment).toBe('test');
    expect(body.requestId).toBeDefined();
    expect(res.body).not.toContain('API_KEY');
    expect(res.body).not.toContain('AIzaSy');
  });

  // 3. CHAT ENDPOINT (JSON AND SSE STREAMING)
  it('Chat: POST /api/v1/chat processes prompt and supports SSE streaming', async () => {
    // Normal JSON chat
    const chatRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: {
        messages: [{ role: 'user', content: 'What is a general ledger?' }],
      },
    });
    expect(chatRes.statusCode).toBe(200);
    const chatBody = JSON.parse(chatRes.body);
    expect(chatBody.success).toBe(true);
    expect(chatBody.data.content).toContain('Mock AI response');

    // Streaming SSE chat
    const streamRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      payload: {
        messages: [{ role: 'user', content: 'Explain liquidity' }],
        stream: true,
      },
    });
    expect(streamRes.statusCode).toBe(200);
    expect(streamRes.headers['content-type']).toContain('text/event-stream');
    expect(streamRes.body).toContain('data: ');
    expect(streamRes.body).toContain('[DONE]');
  });

  // 4. INVALID PDF TESTS
  it('Rejection: rejects non-PDF file content without %PDF magic bytes', async () => {
    const corruptBuffer = Buffer.from('NOT_A_REAL_PDF_DOCUMENT_TEXT');
    const { payload, contentType } = createMultipartPayload('corrupt.pdf', corruptBuffer);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(415);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNSUPPORTED_DOCUMENT_TYPE');
    expect(body.error.message).toContain('magic bytes');
  });

  it('Rejection: rejects disallowed file extension (.sh)', async () => {
    const { payload, contentType } = createMultipartPayload('script.sh', validPdfContent);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(415);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('UNSUPPORTED_DOCUMENT_TYPE');
    expect(body.error.message).toContain("Unsupported file extension '.sh'");
  });

  it('Rejection: rejects encrypted / password-protected PDF', async () => {
    const encryptedPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Encrypt 4 0 R >>\n%%EOF'
    );
    const { payload, contentType } = createMultipartPayload('encrypted.pdf', encryptedPdf);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('FILE_VALIDATION_ERROR');
    expect(body.error.message).toContain('password-protected or encrypted');
  });

  it('Rejection: rejects PDF exceeding configured page count limit', async () => {
    // Generate PDF with page count exceeding maxPdfPages (configured to 5)
    let pageNodes = '';
    for (let i = 0; i < 10; i++) {
      pageNodes += `/Type /Page\n`;
    }
    const oversizedPagePdf = Buffer.from(`%PDF-1.4\n${pageNodes}%%EOF`);
    const { payload, contentType } = createMultipartPayload('huge-pages.pdf', oversizedPagePdf);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('FILE_VALIDATION_ERROR');
    expect(body.error.message).toContain('exceeds the maximum allowed limit of 5 pages');
  });

  // 5. OVERSIZED FILE TEST
  it('Rejection: rejects file exceeding maxUploadSizeBytes', async () => {
    // 1MB + 100KB buffer
    const oversizedBuffer = Buffer.alloc(1024 * 1024 + 102400);
    oversizedBuffer.write('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF');
    const { payload, contentType } = createMultipartPayload('huge.pdf', oversizedBuffer);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect([400, 413]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // 6. MALFORMED INPUT TESTS
  it('Malformed Input: rejects non-multipart request to /documents/process', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': 'application/json' },
      payload: { dummy: 'data' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FILE_VALIDATION_ERROR');
    expect(body.error.message).toContain('Expected multipart/form-data');
  });

  it('Malformed Input: rejects empty file buffer', async () => {
    const { payload, contentType } = createMultipartPayload('empty.pdf', Buffer.alloc(0));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('FILE_VALIDATION_ERROR');
    expect(body.error.message).toContain('empty');
  });

  it('Malformed Input: rejects invalid payload on /documents/download', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/download',
      headers: { 'content-type': 'application/json' },
      payload: { xlsxBase64: 'short' }, // Less than min 10 chars
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  // 7. GEMINI / PROVIDER FAILURE
  it('Provider Failure: returns structured error when AI provider encounters unrecoverable failure', async () => {
    const failingAi = new MockAIProvider();
    failingAi.shouldFail = true;
    failingAi.failureMessage = 'Gemini 503 Backend Overloaded';

    const testConfig = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      MAX_EXTRACTION_RETRIES: '0',
    });
    const localApp = await buildApp({ config: testConfig, aiProvider: failingAi });
    await localApp.ready();

    const { payload, contentType } = createMultipartPayload('invoice.pdf', validPdfContent);
    const res = await localApp.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect([422, 500, 502]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('Gemini 503 Backend Overloaded');

    await localApp.close();
  });

  // 8. SCHEMA VALIDATION FAILURE AND RETRY RECOVERY
  it('Validation & Recovery: escalates model and retries when initial AI response violates schema', async () => {
    const recoveringAi = new MockAIProvider();
    let callsMade = 0;

    recoveringAi.customExtractHandler = (_doc, _ctx, _opts, callCount) => {
      callsMade = callCount || 1;
      if (callCount === 1) {
        // Return structurally invalid payload on first call (missing totals, customer, etc.)
        return {
          documentType: 'unknown_type',
          rawNotes: 'Garbled output without required financial schema',
        };
      }
      // On second call (escalated), return valid complete extraction
      return recoveringAi.mockExtractionData;
    };

    const testConfig = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      MAX_EXTRACTION_RETRIES: '2',
    });
    const localApp = await buildApp({ config: testConfig, aiProvider: recoveringAi });
    await localApp.ready();

    const { payload, contentType } = createMultipartPayload('invoice.pdf', validPdfContent);
    const res = await localApp.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(callsMade).toBeGreaterThanOrEqual(2);
    expect(body.data.auditTrail.retryCount).toBeGreaterThanOrEqual(1);
    expect(body.data.auditTrail.modelsUsed.length).toBeGreaterThanOrEqual(2);

    await localApp.close();
  });

  // 9. RECONCILIATION FAILURE
  it('Reconciliation Discrepancy: returns 200 REVIEW_REQUIRED with exact discrepancy breakdown and reviewToken when figures do not balance', async () => {
    const unbalancedAi = new MockAIProvider();
    unbalancedAi.mockExtractionData = {
      ...unbalancedAi.mockExtractionData,
      totals: {
        ...unbalancedAi.mockExtractionData.totals,
        grandTotal: 123456.78, // Blatant mismatch
      },
    };

    const testConfig = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      MAX_EXTRACTION_RETRIES: '0',
    });
    const localApp = await buildApp({ config: testConfig, aiProvider: unbalancedAi });
    await localApp.ready();

    const { payload, contentType } = createMultipartPayload('invoice.pdf', validPdfContent);
    const res = await localApp.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.isVerified).toBe(false);
    expect(body.data.reconciliation.isVerified).toBe(false);
    expect(body.data.summary.status).toBe('REVIEW_REQUIRED');
    expect(body.data.summary.review.required).toBe(true);
    expect(body.data.summary.review.reviewToken).toBeDefined();
    expect(body.data.reconciliation.discrepancies.length).toBeGreaterThan(0);

    await localApp.close();
  });

  // 10. RETRY & CORRECTION LOOP ON RECONCILIATION DISCREPANCY
  it('Correction Loop: auto-corrects discrepancy via AI correction loop and achieves verified match', async () => {
    const correctingAi = new MockAIProvider();

    correctingAi.customExtractHandler = (_doc, _ctx, _opts, callCount) => {
      if (callCount === 1) {
        // Return slight discrepancy on first call (subtotal mismatch)
        return {
          ...correctingAi.mockExtractionData,
          totals: {
            ...correctingAi.mockExtractionData.totals,
            subtotal: 9999.0, // Initial error
          },
        };
      }
      // On correction loop (call 2), return reconciled data
      return correctingAi.mockExtractionData;
    };

    const testConfig = loadConfig({
      NODE_ENV: 'test',
      AI_PROVIDER: 'mock',
      MAX_EXTRACTION_RETRIES: '2',
    });
    const localApp = await buildApp({ config: testConfig, aiProvider: correctingAi });
    await localApp.ready();

    const { payload, contentType } = createMultipartPayload('invoice.pdf', validPdfContent);
    const res = await localApp.inject({
      method: 'POST',
      url: '/api/v1/documents/process',
      headers: { 'content-type': contentType },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.reconciliation.overallStatus).toBe('EXACT_MATCH');
    expect(body.data.auditTrail.retryCount).toBeGreaterThanOrEqual(1);

    await localApp.close();
  });
});
