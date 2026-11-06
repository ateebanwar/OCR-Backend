import path from 'node:path';
import crypto from 'node:crypto';
import {
  FileValidationError,
  UnsupportedDocumentError,
} from '../errors/AppError';
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

const PDF_HEADER = Buffer.from('%PDF-');
const PDF_HEADER_MAX_OFFSET = 1023;
const MAX_FILENAME_LENGTH = 100;

export function sanitizeFilename(filename: string): string {
  if (typeof filename !== 'string' || filename.trim().length === 0) {
    throw new FileValidationError('Invalid filename.');
  }

  const basename = path.basename(filename.trim());

  const sanitized = basename
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, MAX_FILENAME_LENGTH);

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new FileValidationError('Invalid filename.');
  }

  return sanitized;
}

export function isPdfEncrypted(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Invalid PDF buffer.');
  }

  const content = buffer.toString('latin1');

  return /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(content);
}

export function validatePdfBuffer(
  buffer: Buffer,
  originalFilename: string,
  maxSizeBytes: number,
  maxPages = 50
): ValidatedFile {
  // 1. Validate uploaded buffer
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new FileValidationError('Uploaded file is empty or invalid.');
  }

  // 2. Validate configured size limit
  if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes < 1) {
    throw new RangeError('Invalid maximum file size configuration.');
  }

  if (buffer.length > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
    const actualMb = (buffer.length / (1024 * 1024)).toFixed(1);

    throw new FileValidationError(
      `File size (${actualMb}MB) exceeds limit of ${maxMb}MB.`
    );
  }

  // 3. Validate filename
  if (
    typeof originalFilename !== 'string' ||
    originalFilename.trim().length === 0
  ) {
    throw new FileValidationError('Invalid filename.');
  }

  const sanitized = sanitizeFilename(originalFilename);
  const ext = path.extname(sanitized).toLowerCase();

  // 4. Validate PDF extension
  if (ext !== '.pdf') {
    throw new UnsupportedDocumentError(
      `Unsupported file extension '${ext}'. Only .pdf is allowed.`
    );
  }

  // 5. Verify PDF header within the first 1024 bytes
  const headerIndex = buffer
    .subarray(0, Math.min(buffer.length, PDF_HEADER_MAX_OFFSET + PDF_HEADER.length))
    .indexOf(PDF_HEADER);

  if (headerIndex < 0 || headerIndex > PDF_HEADER_MAX_OFFSET) {
    throw new UnsupportedDocumentError(
      'Invalid file format. PDF signature (%PDF-) was not found in the first 1024 bytes.'
    );
  }

  // 6. Reject encrypted PDFs
  if (isPdfEncrypted(buffer)) {
    throw new FileValidationError(
      'The uploaded PDF appears to be password-protected or encrypted. Please provide an unencrypted document.'
    );
  }

  // 7. Validate maximum page configuration
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError('Invalid maximum PDF page configuration.');
  }

  // 8. Estimate and enforce page count
  const pageCount = estimatePageCount(buffer);

  if (pageCount === 0) {
    throw new FileValidationError(
      'Unable to determine the PDF page count. The document cannot be safely validated.'
    );
  }

  if (pageCount > maxPages) {
    throw new FileValidationError(
      `Document page count (${pageCount}) exceeds the maximum allowed limit of ${maxPages} pages.`
    );
  }

  // 9. Generate a unique document identifier
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
