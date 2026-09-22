import { describe, it, expect } from 'vitest';
import { validatePdfBuffer, sanitizeFilename } from '../../src/security/fileValidator';
import { FileValidationError } from '../../src/errors/AppError';

describe('PDF Ingestion Security', () => {
  it('detects and rejects password-protected or encrypted PDFs early', () => {
    const encryptedPdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 12 0 R >>\n%%EOF'
    );

    expect(() =>
      validatePdfBuffer(encryptedPdfBuffer, 'secure_invoice.pdf', 15 * 1024 * 1024, 50)
    ).toThrowError(FileValidationError);

    expect(() =>
      validatePdfBuffer(encryptedPdfBuffer, 'secure_invoice.pdf', 15 * 1024 * 1024, 50)
    ).toThrowError(/password-protected or encrypted/);
  });

  it('rejects PDFs exceeding the configured page limit', () => {
    let multiPageContent = '%PDF-1.4\n';
    for (let i = 0; i < 25; i++) {
      multiPageContent += `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`;
    }
    multiPageContent += '%%EOF';

    const buffer = Buffer.from(multiPageContent);

    // Limit configured to 10 pages, document has 25
    expect(() =>
      validatePdfBuffer(buffer, 'large_statement.pdf', 15 * 1024 * 1024, 10)
    ).toThrowError(FileValidationError);

    expect(() =>
      validatePdfBuffer(buffer, 'large_statement.pdf', 15 * 1024 * 1024, 10)
    ).toThrowError(/exceeds the maximum allowed limit of 10 pages/);
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
