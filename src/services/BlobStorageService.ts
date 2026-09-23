import crypto from 'node:crypto';
import { FastifyRequest } from 'fastify';
import { get, del, head } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken, handleUpload, HandleUploadBody } from '@vercel/blob/client';
import { AppConfig } from '../config/env';
import { ConfigurationError, FileValidationError } from '../errors/AppError';
import { sanitizeFilename } from '../security/fileValidator';

export interface RetrievedBlob {
  buffer: Buffer;
  filename: string;
  pathname: string;
  sizeBytes: number;
}

export interface UploadTokenResult {
  clientToken: string;
  blobPathname: string;
  maxSizeBytes: number;
  allowedContentTypes: string[];
}

export interface BlobStorageAdapter {
  get(urlOrPathname: string, options: { access: 'private'; token?: string; useCache?: boolean }): Promise<any>;
  del(urlOrPathname: string | string[], options: { token?: string }): Promise<void>;
  head(urlOrPathname: string, options: { token?: string }): Promise<any>;
  generateClientToken(options: any): Promise<string>;
}

export class BlobStorageService {
  private readonly config: AppConfig;
  private readonly adapter: BlobStorageAdapter;

  // Regex pattern enforcing strict server-controlled namespace:
  // ocr-intelligence/uploads/<UUID>/<safe-filename>.pdf
  public static readonly PATHNAME_REGEX = /^ocr-intelligence\/uploads\/[0-9a-fA-F-]{36}\/[a-zA-Z0-9_.-]+\.pdf$/i;

  constructor(config: AppConfig, customAdapter?: BlobStorageAdapter) {
    this.config = config;
    this.adapter = customAdapter || {
      get: (urlOrPathname, options) => get(urlOrPathname, options),
      del: (urlOrPathname, options) => del(urlOrPathname, options),
      head: (urlOrPathname, options) => head(urlOrPathname, options),
      generateClientToken: (options) => generateClientTokenFromReadWriteToken(options),
    };
  }

  /**
   * Sanitizes the blob token, stripping any accidental 'BLOB_READ_WRITE_TOKEN=' prefix,
   * whitespace, newlines, and surrounding double or single quotes.
   */
  public static cleanToken(rawToken?: string): string | undefined {
    if (!rawToken) return undefined;
    let t = rawToken.trim();
    t = t.replace(/^BLOB_READ_WRITE_TOKEN\s*=\s*/i, '').trim();
    t = t.replace(/^["']|["']$/g, '').trim();
    return t.length > 0 ? t : undefined;
  }

  private getToken(): string {
    const raw = this.config.blobReadWriteToken || process.env.BLOB_READ_WRITE_TOKEN;
    const token = BlobStorageService.cleanToken(raw);
    if (!token) {
      throw new ConfigurationError('SERVER_CONFIGURATION_ERROR: BLOB_READ_WRITE_TOKEN is not configured.');
    }
    return token;
  }

  /**
   * Validates whether a pathname strictly conforms to the trusted server-controlled namespace.
   * Defends against SSRF, directory traversal (..), and arbitrary object access.
   */
  public isValidBlobPathname(pathname: string): boolean {
    if (!pathname || typeof pathname !== 'string') {
      return false;
    }
    // Reject full URLs (http:// or https://) to prevent SSRF
    if (pathname.includes('://') || pathname.startsWith('//')) {
      return false;
    }
    // Reject path traversal
    if (pathname.includes('..') || pathname.includes('\\')) {
      return false;
    }
    return BlobStorageService.PATHNAME_REGEX.test(pathname.trim());
  }

  /**
   * Generates a controlled, namespaced pathname:
   * ocr-intelligence/uploads/<UUID>/<safe-filename>.pdf
   */
  public generateControlledPathname(rawFilename: string): { pathname: string; cleanFilename: string } {
    const sanitizedBase = sanitizeFilename(rawFilename || 'document.pdf');
    const cleanFilename = sanitizedBase.toLowerCase().endsWith('.pdf') ? sanitizedBase : `${sanitizedBase}.pdf`;
    const uuid = crypto.randomUUID();
    const pathname = `ocr-intelligence/uploads/${uuid}/${cleanFilename}`;
    return { pathname, cleanFilename };
  }

  /**
   * Issues an authorized client upload token for direct frontend-to-private-blob uploads.
   * Enforces 25 MB max size, application/pdf only, and 10 minute expiration.
   */
  public async generateUploadToken(filename: string): Promise<UploadTokenResult> {
    const token = this.getToken();
    const { pathname } = this.generateControlledPathname(filename);

    const clientToken = await this.adapter.generateClientToken({
      token,
      pathname,
      maximumSizeInBytes: this.config.maxUploadSizeBytes,
      allowedContentTypes: ['application/pdf'],
      validUntil: Date.now() + 10 * 60 * 1000,
    });

    return {
      clientToken,
      blobPathname: pathname,
      maxSizeBytes: this.config.maxUploadSizeBytes,
      allowedContentTypes: ['application/pdf'],
    };
  }

  /**
   * Handles official @vercel/blob/client handleUpload event payloads.
   */
  public async handleClientUpload(request: FastifyRequest, body: HandleUploadBody): Promise<any> {
    const token = this.getToken();
    return handleUpload({
      body,
      request: request.raw,
      token,
      onBeforeGenerateToken: async (pathname) => {
        // Enforce server-controlled namespace
        if (!this.isValidBlobPathname(pathname)) {
          throw new FileValidationError('Invalid upload destination pathname. Path must reside within the controlled upload namespace.');
        }
        return {
          allowedContentTypes: ['application/pdf'],
          maximumSizeInBytes: this.config.maxUploadSizeBytes,
          validUntil: Date.now() + 10 * 60 * 1000,
        };
      },
    });
  }

  /**
   * Securely retrieves a private blob from Vercel Blob storage:
   * 1. Validates pathname format and namespace (prevents SSRF and traversal).
   * 2. Retrieves private blob with access: 'private'.
   * 3. Streams and verifies actual byte size <= 25 MB (prevents unbounded memory consumption).
   * 4. Returns buffer and extracted filename.
   */
  public async retrieveBlob(pathname: string): Promise<RetrievedBlob> {
    if (!this.isValidBlobPathname(pathname)) {
      throw new FileValidationError(
        'Invalid Blob reference. Pathname must match the controlled PDF upload namespace.'
      );
    }

    const token = this.getToken();
    const cleanPath = pathname.trim();

    let response: any;
    try {
      response = await this.adapter.get(cleanPath, {
        access: 'private',
        token,
        useCache: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown blob error';
      throw new FileValidationError(`Failed to retrieve referenced blob: ${msg}`);
    }

    if (!response || response.statusCode !== 200 || !response.stream) {
      throw new FileValidationError('Referenced blob was not found or has expired.');
    }

    // Stream and enforce maximum byte size during read
    const buffer = await this.streamToBufferWithLimit(
      response.stream,
      this.config.maxUploadSizeBytes
    );

    // Extract filename from pathname
    const pathParts = cleanPath.split('/');
    const lastPart = pathParts[pathParts.length - 1];
    const filename = lastPart && lastPart.trim() ? lastPart.trim() : 'document.pdf';

    return {
      buffer,
      filename,
      pathname: cleanPath,
      sizeBytes: buffer.length,
    };
  }

  /**
   * Deletes a blob from Vercel Blob store.
   * Safe/fault-tolerant: logs sanitized error on failure without leaking credentials or throwing.
   */
  public async deleteBlob(pathname: string, log?: { warn: (obj: any, msg?: string) => void }): Promise<void> {
    if (!pathname || typeof pathname !== 'string') {
      return;
    }

    try {
      const token = this.getToken();
      await this.adapter.del(pathname.trim(), { token });
    } catch (err: unknown) {
      if (log) {
        log.warn(
          {
            pathname: pathname.slice(0, 100),
            error: err instanceof Error ? err.message : 'Unknown cleanup error',
          },
          'Failed to cleanup source PDF from Blob storage'
        );
      }
    }
  }

  /**
   * Reads a ReadableStream into a Buffer, enforcing the maximum byte limit on the fly.
   */
  private async streamToBufferWithLimit(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel('File size exceeds maximum allowed size');
            throw new FileValidationError(
              `Uploaded file exceeds the maximum allowed size of ${maxBytes / (1024 * 1024)}MB.`
            );
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks);
  }
}
