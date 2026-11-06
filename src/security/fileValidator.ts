import path from 'node:path';
import crypto from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  FileValidationError,
  UnsupportedDocumentError,
} from '../errors/AppError';

export interface ValidatedFile {
  documentId: string;
  originalFilename: string;
  sanitizedFilename: string;
  buffer: Buffer;
  byteSize: number;
  mimeType: string;
  pageCount: number;
}

interface PdfInspection {
  pageCount: number;
  isEncrypted: boolean;
}

const PDF_HEADER = Buffer.from('%PDF-');
const PDF_HEADER_MAX_OFFSET = 1023;
const MAX_FILENAME_LENGTH = 100;

export function sanitizeFilename(filename: string): string {
  if (typeof filename !== 'string' || filename.trim().length === 0) {
    throw new FileValidationError('Invalid filename.');
  }

  // Handle Windows and Unix path separators.
  const basename = filename.trim().split(/[\\/]/).pop() ?? '';

  const sanitized = basename
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(0, MAX_FILENAME_LENGTH);

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new FileValidationError('Invalid filename.');
  }

  return sanitized;
}

async function inspectPdf(buffer: Buffer): Promise<PdfInspection> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new FileValidationError('Uploaded PDF is empty or invalid.');
  }

  let loadingTask:
    | ReturnType<typeof getDocument>
    | undefined;

  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      stopAtErrors: true,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
    });

    const pdf = await loadingTask.promise;

    try {
      const permissions = await pdf.getPermissions();

      return {
        pageCount: pdf.numPages,
        isEncrypted: permissions !== null,
      };
    } finally {
      await pdf.destroy();
    }
  } catch (error: unknown) {
    const pdfError = error as Error;

    if (pdfError?.name === 'PasswordException') {
      throw new FileValidationError(
        'The uploaded PDF is password-protected or encrypted. Please provide an unencrypted document.'
      );
    }

    if (error instanceof FileValidationError) {
      throw error;
    }

    throw new FileValidationError(
      'Invalid, corrupted, encrypted, or unsupported PDF document.'
    );
  } finally {
    if (loadingTask) {
      await loadingTask.destroy().catch(() => undefined);
    }
  }
}

export async function isPdfEncrypted(
  buffer: Buffer
): Promise<boolean> {
  const inspection = await inspectPdf(buffer);
  return inspection.isEncrypted;
}

export async function validatePdfBuffer(
  buffer: Buffer,
  originalFilename: string,
  maxSizeBytes: number,
  maxPages = 50
): Promise<ValidatedFile> {
  // 1. Validate buffer
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new FileValidationError(
      'Uploaded file is empty or invalid.'
    );
  }

  // 2. Validate configured limits
  if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes < 1) {
    throw new RangeError(
      'Invalid maximum file size configuration.'
    );
  }

  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError(
      'Invalid maximum PDF page configuration.'
    );
  }

  if (buffer.length > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
    const actualMb = (buffer.length / (1024 * 1024)).toFixed(1);

    throw new FileValidationError(
      'File size (' + actualMb + 'MB) exceeds limit of ' + maxMb + 'MB.'
    );
  }

  // 3. Validate filename and extension
  const sanitized = sanitizeFilename(originalFilename);
  const ext = path.extname(sanitized).toLowerCase();

  if (ext !== '.pdf') {
    throw new UnsupportedDocumentError(
      "Unsupported file extension '" + ext + "'. Only .pdf is allowed."
    );
  }

  // 4. Verify PDF signature within first 1024 bytes
  const headerIndex = buffer
    .subarray(
      0,
      Math.min(
        buffer.length,
        PDF_HEADER_MAX_OFFSET + PDF_HEADER.length
      )
    )
    .indexOf(PDF_HEADER);

  if (headerIndex < 0 || headerIndex > PDF_HEADER_MAX_OFFSET) {
    throw new UnsupportedDocumentError(
      'Invalid PDF signature: PDF magic bytes (%PDF-) were not found within the first 1024 bytes.'
    );
  }

  // 5. Parse actual PDF structure
  const inspection = await inspectPdf(buffer);

  if (inspection.isEncrypted) {
    throw new FileValidationError(
      'The uploaded PDF is encrypted. Please provide an unencrypted document.'
    );
  }

  // 6. Enforce actual page count
  const pageCount = inspection.pageCount;

  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new FileValidationError(
      'Unable to determine a valid PDF page count.'
    );
  }

  if (pageCount > maxPages) {
    throw new FileValidationError(
      'Document page count (' + pageCount + ') exceeds the maximum allowed limit of ' + maxPages + ' pages.'
    );
  }

  // 7. Generate document identifier
  const documentId = crypto.randomUUID();

  return {
    documentId,
    originalFilename,
    sanitizedFilename: documentId + '_' + sanitized,
    buffer,
    byteSize: buffer.length,
    mimeType: 'application/pdf',
    pageCount,
  };
}
