import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDocument } = vi.hoisted(() => ({
  mockGetDocument: vi.fn(),
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: mockGetDocument,
}));

import {
  validatePdfBuffer,
  sanitizeFilename,
  isPdfEncrypted,
} from '../../src/security/fileValidator';

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 50;

function createPdfBuffer(): Buffer {
  return Buffer.from(
    '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF',
    'latin1'
  );
}

function createMockPdfTask(options?: {
  pageCount?: number;
  permissions?: unknown;
  rejectWith?: Error;
}) {
  const pdfDocument = {
    numPages: options?.pageCount ?? 1,
    getPermissions: vi.fn().mockResolvedValue(
      options?.permissions ?? null
    ),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  const loadingTask = {
    promise: options?.rejectWith
      ? Promise.reject(options.rejectWith)
      : Promise.resolve(pdfDocument),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  mockGetDocument.mockReturnValue(loadingTask);

  return {
    pdfDocument,
    loadingTask,
  };
}

describe('fileValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sanitizeFilename', () => {
    it('should preserve a valid PDF filename', () => {
      expect(sanitizeFilename('invoice.pdf')).toBe('invoice.pdf');
    });

    it('should replace unsafe characters', () => {
      expect(sanitizeFilename('invoice 2026.pdf')).toBe(
        'invoice_2026.pdf'
      );
    });

    it('should remove directory traversal components', () => {
      expect(sanitizeFilename('../../invoice.pdf')).toBe(
        'invoice.pdf'
      );
    });

    it('should reject an empty filename', () => {
      expect(() => sanitizeFilename('')).toThrow();
    });

    it('should reject whitespace-only filenames', () => {
      expect(() => sanitizeFilename('   ')).toThrow();
    });

    it('should reject non-string filenames', () => {
      expect(() => sanitizeFilename(null as unknown as string)).toThrow();
    });

    it('should limit filename length', () => {
      const filename = `${'a'.repeat(150)}.pdf`;
      const result = sanitizeFilename(filename);

      expect(result.length).toBeLessThanOrEqual(100);
    });
  });

  describe('validatePdfBuffer', () => {
    it('should accept a valid single-page PDF', async () => {
      createMockPdfTask({ pageCount: 1 });

      const result = await validatePdfBuffer(
        createPdfBuffer(),
        'invoice.pdf',
        DEFAULT_MAX_SIZE
      );

      expect(result.pageCount).toBe(1);
      expect(result.originalFilename).toBe('invoice.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.documentId).toBeTruthy();
    });

    it('should accept a valid multi-page PDF', async () => {
      createMockPdfTask({ pageCount: 5 });

      const result = await validatePdfBuffer(
        createPdfBuffer(),
        'report.pdf',
        DEFAULT_MAX_SIZE
      );

      expect(result.pageCount).toBe(5);
    });

    it('should return a sanitized filename with document ID', async () => {
      createMockPdfTask();

      const result = await validatePdfBuffer(
        createPdfBuffer(),
        'my report.pdf',
        DEFAULT_MAX_SIZE
      );

      expect(result.sanitizedFilename).toMatch(
        /^[0-9a-f-]{36}_my_report\.pdf$/i
      );
    });

    it('should generate unique document IDs', async () => {
      createMockPdfTask();

      const first = await validatePdfBuffer(
        createPdfBuffer(),
        'first.pdf',
        DEFAULT_MAX_SIZE
      );

      createMockPdfTask();

      const second = await validatePdfBuffer(
        createPdfBuffer(),
        'second.pdf',
        DEFAULT_MAX_SIZE
      );

      expect(first.documentId).not.toBe(second.documentId);
    });

    it('should preserve the original buffer', async () => {
      createMockPdfTask();

      const buffer = createPdfBuffer();

      const result = await validatePdfBuffer(
        buffer,
        'invoice.pdf',
        DEFAULT_MAX_SIZE
      );

      expect(result.buffer).toBe(buffer);
      expect(result.byteSize).toBe(buffer.length);
    });

    it('should reject an empty buffer', async () => {
      await expect(
        validatePdfBuffer(
          Buffer.alloc(0),
          'empty.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow('Uploaded file is empty or invalid.');
    });

    it('should reject a non-Buffer input', async () => {
      await expect(
        validatePdfBuffer(
          'not-a-buffer' as unknown as Buffer,
          'invoice.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow('Uploaded file is empty or invalid.');
    });

    it('should reject a missing PDF signature', async () => {
      const invalidBuffer = Buffer.from(
        'This is not a PDF document'
      );

      await expect(
        validatePdfBuffer(
          invalidBuffer,
          'invoice.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow('Invalid PDF signature');

      expect(mockGetDocument).not.toHaveBeenCalled();
    });

    it('should accept a PDF signature within the first 1024 bytes', async () => {
      createMockPdfTask();

      const prefix = Buffer.alloc(100, 0x20);
      const buffer = Buffer.concat([
        prefix,
        createPdfBuffer(),
      ]);

      const result = await validatePdfBuffer(
        buffer,
        'invoice.pdf',
        DEFAULT_MAX_SIZE
      );

      expect(result.pageCount).toBe(1);
    });

    it('should reject a PDF signature beyond the first 1024 bytes', async () => {
      const prefix = Buffer.alloc(1024, 0x20);

      const buffer = Buffer.concat([
        prefix,
        createPdfBuffer(),
      ]);

      await expect(
        validatePdfBuffer(
          buffer,
          'invoice.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow('Invalid PDF signature');
    });

    it('should reject non-PDF extensions', async () => {
      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'invoice.txt',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow();
    });

    it('should reject files exceeding maximum size', async () => {
      const buffer = createPdfBuffer();

      await expect(
        validatePdfBuffer(
          buffer,
          'invoice.pdf',
          10
        )
      ).rejects.toThrow('exceeds limit');
    });

    it('should reject invalid maximum file size configuration', async () => {
      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'invoice.pdf',
          0
        )
      ).rejects.toThrow(
        'Invalid maximum file size configuration.'
      );
    });

    it('should reject negative maximum file size', async () => {
      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'invoice.pdf',
          -100
        )
      ).rejects.toThrow();
    });

    it('should reject invalid maximum page configuration', async () => {
      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'invoice.pdf',
          DEFAULT_MAX_SIZE,
          0
        )
      ).rejects.toThrow(
        'Invalid maximum PDF page configuration.'
      );
    });

    it('should reject non-integer maximum page configuration', async () => {
      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'invoice.pdf',
          DEFAULT_MAX_SIZE,
          2.5
        )
      ).rejects.toThrow();
    });

    it('should reject PDFs exceeding the maximum page count', async () => {
      createMockPdfTask({ pageCount: 51 });

      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'large.pdf',
          DEFAULT_MAX_SIZE,
          DEFAULT_MAX_PAGES
        )
      ).rejects.toThrow('exceeds the maximum allowed limit');
    });

    it('should accept PDFs exactly at the maximum page count', async () => {
      createMockPdfTask({ pageCount: 50 });

      const result = await validatePdfBuffer(
        createPdfBuffer(),
        'report.pdf',
        DEFAULT_MAX_SIZE,
        50
      );

      expect(result.pageCount).toBe(50);
    });

    it('should reject a zero-page PDF', async () => {
      createMockPdfTask({ pageCount: 0 });

      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'empty.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow('Unable to determine a valid PDF page count.');
    });

    it('should reject an invalid page count', async () => {
      createMockPdfTask({ pageCount: Number.NaN });

      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'invalid.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow('Unable to determine a valid PDF page count.');
    });

    it('should reject encrypted PDFs detected through permissions', async () => {
      createMockPdfTask({ permissions: [] });

      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'encrypted.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow('encrypted');
    });

    it('should reject password-protected PDFs', async () => {
      const passwordError = Object.assign(
        new Error('Password required'),
        { name: 'PasswordException' }
      );

      createMockPdfTask({
        rejectWith: passwordError,
      });

      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'protected.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow('password-protected');
    });

    it('should reject malformed PDFs when PDF.js parsing fails', async () => {
      createMockPdfTask({
        rejectWith: new Error('Invalid PDF structure'),
      });

      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'malformed.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow(
        'Invalid, corrupted, encrypted, or unsupported PDF document.'
      );
    });

    it('should destroy PDF resources after successful parsing', async () => {
      const { pdfDocument, loadingTask } = createMockPdfTask();

      await validatePdfBuffer(
        createPdfBuffer(),
        'invoice.pdf',
        DEFAULT_MAX_SIZE
      );

      expect(pdfDocument.destroy).toHaveBeenCalled();
      expect(loadingTask.destroy).toHaveBeenCalled();
    });

    it('should destroy loading task after parsing failure', async () => {
      const { loadingTask } = createMockPdfTask({
        rejectWith: new Error('Parser failure'),
      });

      await expect(
        validatePdfBuffer(
          createPdfBuffer(),
          'invoice.pdf',
          DEFAULT_MAX_SIZE
        )
      ).rejects.toThrow();

      expect(loadingTask.destroy).toHaveBeenCalled();
    });
  });

  describe('isPdfEncrypted', () => {
    it('should return false for an unencrypted PDF', async () => {
      createMockPdfTask({ permissions: null });

      const result = await isPdfEncrypted(createPdfBuffer());

      expect(result).toBe(false);
    });

    it('should return true when PDF permissions are present', async () => {
      createMockPdfTask({ permissions: [] });

      const result = await isPdfEncrypted(createPdfBuffer());

      expect(result).toBe(true);
    });

    it('should reject invalid buffer input', async () => {
      await expect(
        isPdfEncrypted('invalid' as unknown as Buffer)
      ).rejects.toThrow('Uploaded PDF is empty or invalid.');
    });

    it('should reject parser failures', async () => {
      createMockPdfTask({
        rejectWith: new Error('PDF parsing failed'),
      });

      await expect(
        isPdfEncrypted(createPdfBuffer())
      ).rejects.toThrow();
    });
  });
});
