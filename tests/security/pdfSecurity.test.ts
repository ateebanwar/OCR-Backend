import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURES_DIR = path.resolve('tests/fixtures/documents');
import { validatePdfBuffer, sanitizeFilename } from '../../src/security/fileValidator';
import { FileValidationError } from '../../src/errors/AppError';

describe('PDF Ingestion Security', () => {
  it('detects and rejects password-protected or encrypted PDFs early', async () => {
    const encryptedPdfBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'test16_encrypted.pdf'));

    await expect(
      validatePdfBuffer(encryptedPdfBuffer, 'secure_invoice.pdf', 15 * 1024 * 1024, 50)
    ).rejects.toBeInstanceOf(FileValidationError);

    await expect(
      validatePdfBuffer(encryptedPdfBuffer, 'secure_invoice.pdf', 15 * 1024 * 1024, 50)
    ).rejects.toThrow(/password-protected or encrypted/i);
  });

  it('rejects PDFs exceeding the configured page limit', async () => {
    const buffer = fs.readFileSync(path.join(FIXTURES_DIR, 'test02_multipage_invoice.pdf'));

    await expect(
      validatePdfBuffer(buffer, 'large_statement.pdf', 15 * 1024 * 1024, 1)
    ).rejects.toBeInstanceOf(FileValidationError);

    await expect(
      validatePdfBuffer(buffer, 'large_statement.pdf', 15 * 1024 * 1024, 1)
    ).rejects.toThrow(/exceeds the maximum allowed limit of 1 pages/i);
  });

  it('sanitizes Unicode Right-to-Left Override (RTLO) and control characters in filenames', () => {
    // \u202E is Right-to-Left Override used in spoofing attacks like "invoice_[\u202E]fdp.exe"
    const dangerousFilename = 'invoice_\u202Efdp.exe.pdf';
    const sanitized = sanitizeFilename(dangerousFilename);

    expect(sanitized).not.toContain('\u202E');
    expect(sanitized).toBe('invoice_fdp.exe.pdf');

    // Null bytes and control characters
    const controlCharFilename = 'invoice\x00\x08\x1F.pdf';
    const sanitizedControl = sanitizeFilename(controlCharFilename);
    expect(sanitizedControl).toBe('invoice.pdf');
  });
});
