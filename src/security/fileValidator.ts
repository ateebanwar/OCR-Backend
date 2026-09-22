import path from 'node:path';
import crypto from 'node:crypto';
import { FileValidationError, UnsupportedDocumentError } from '../errors/AppError';
import { estimatePageCount } from '../documents/complexityAnalyzer';

export interface ValidatedFile {
  documentId: string;
  originalFilename: string;
  sanitizedFilename: string;
  buffer: Buffer;
  byteSize: number;
  mimeType: string;
  pageCount: number;
}

const PDF_MAGIC_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

/**
 * Hardened filename sanitizer:
 * - Strips directory traversal (.. / \\)
 * - Strips null bytes and ASCII control characters
 * - Strips Unicode Bidirectional overrides (e.g. U+202E RTL override)
 * - Enforces safe alphanumeric, dot, underscore, hyphen whitelist
 * - Bounded length (max 100 chars)
 */
export function sanitizeFilename(filename: string): string {
  const basename = path.basename(filename);
  const sanitized = basename
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '') // Strip Unicode Bidi overrides
    .replace(/[\x00-\x1F\x7F]/g, '') // Strip control characters
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);

  return sanitized || 'document.pdf';
}

export function isPdfEncrypted(buffer: Buffer): boolean {
  const content = buffer.toString('latin1');
  return /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(content);
}

export function validatePdfBuffer(
  buffer: Buffer,
  originalFilename: string,
  maxSizeBytes: number,
  maxPages = 50
): ValidatedFile {
  if (!buffer || buffer.length === 0) {
    throw new FileValidationError('Uploaded file is empty.');
  }

  if (buffer.length > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
    throw new FileValidationError(`File size (${(buffer.length / (1024 * 1024)).toFixed(1)}MB) exceeds limit of ${maxMb}MB.`);
  }

  // Verify PDF Magic Bytes: First 4 bytes must be %PDF- (0x25, 0x50, 0x44, 0x46)
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(PDF_MAGIC_BYTES)) {
    throw new UnsupportedDocumentError(
      'Invalid file format. The file content does not match the PDF specification magic bytes (%PDF).'
    );
  }

  // Verify extension
  const ext = path.extname(originalFilename).toLowerCase();
  if (ext !== '.pdf') {
    throw new UnsupportedDocumentError(`Unsupported file extension '${ext}'. Only .pdf is allowed.`);
  }

  // Encrypted / Password-Protected PDF Check
  if (isPdfEncrypted(buffer)) {
    throw new FileValidationError(
      'The uploaded PDF is password-protected or encrypted. Please provide an unencrypted document.'
    );
  }

  // Page limit enforcement (protects against multi-thousand page decompression/processing bombs)
  const pageCount = estimatePageCount(buffer);
  if (pageCount > maxPages) {
    throw new FileValidationError(
      `Document page count (${pageCount}) exceeds the maximum allowed limit of ${maxPages} pages.`
    );
  }

  const sanitized = sanitizeFilename(originalFilename);
  const documentId = crypto.randomUUID();

  return {
    documentId,
    originalFilename,
    sanitizedFilename: `${documentId}_${sanitized}`,
    buffer,
    byteSize: buffer.length,
    mimeType: 'application/pdf',
    pageCount,
  };
}
