import { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppConfig } from '../config/env';
import { BlobStorageService, RetrievedBlob } from './BlobStorageService';
import { FileValidationError } from '../errors/AppError';
import { sanitizeFilename } from '../security/fileValidator';

export interface ResolvedDocumentInput {
  buffer: Buffer;
  filename: string;
  sourceType: 'DIRECT' | 'BLOB';
  cleanup?: () => Promise<void>;
}

const blobInputSchema = z.object({
  blobPathname: z.string().min(1, 'blobPathname is required').optional(),
  pathname: z.string().min(1).optional(),
  filename: z.string().max(255).optional(),
}).refine(data => data.blobPathname || data.pathname, {
  message: 'A valid blobPathname is required for Blob document processing.',
});

export class DocumentInputResolver {
  private readonly config: AppConfig;
  private readonly blobService: BlobStorageService;

  constructor(config: AppConfig, blobService?: BlobStorageService) {
    this.config = config;
    this.blobService = blobService || new BlobStorageService(config);
  }

  /**
   * Resolves incoming request into normalized document bytes and metadata.
   * Supports:
   * - Mode A: Direct multipart/form-data upload.
   * - Mode B: Private Vercel Blob reference via application/json.
   */
  public async resolveInput(request: FastifyRequest): Promise<ResolvedDocumentInput> {
    // Mode A: Direct multipart upload
    if (request.isMultipart()) {
      const data = await request.file();

      if (!data) {
        throw new FileValidationError('No file uploaded. Please upload a PDF file using multipart/form-data.');
      }

      if (data.file.truncated) {
        throw new FileValidationError('Uploaded file exceeds the maximum allowed size.');
      }

      const buffer = await data.toBuffer();
      if (!buffer || buffer.length === 0) {
        throw new FileValidationError('Uploaded file buffer is empty.');
      }

      // Check application size limit (25 MB)
      if (buffer.length > this.config.maxUploadSizeBytes) {
        throw new FileValidationError(
          `Uploaded file exceeds the maximum allowed size of ${this.config.maxUploadSizeBytes / (1024 * 1024)}MB.`
        );
      }

      return {
        buffer,
        filename: data.filename || 'uploaded_document.pdf',
        sourceType: 'DIRECT',
      };
    }

    // Mode B: Private Vercel Blob reference via JSON
    const parseResult = blobInputSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new FileValidationError(
        'Invalid content-type or payload. Expected multipart/form-data with PDF file or application/json with a valid blobPathname.'
      );
    }

    const { blobPathname, pathname, filename: customFilename } = parseResult.data;
    const targetPathname = (blobPathname || pathname)!.trim();

    // Securely retrieve the private blob with streaming size limit
    let retrieved: RetrievedBlob;
    try {
      retrieved = await this.blobService.retrieveBlob(targetPathname);
    } catch (err) {
      // Ensure source blob is cleaned up immediately if download or size limit fails
      await this.blobService.deleteBlob(targetPathname, request.log);
      throw err;
    }

    const effectiveFilename = customFilename && customFilename.trim()
      ? sanitizeFilename(customFilename.trim())
      : retrieved.filename;

    return {
      buffer: retrieved.buffer,
      filename: effectiveFilename,
      sourceType: 'BLOB',
      cleanup: async () => {
        await this.blobService.deleteBlob(retrieved.pathname, request.log);
      },
    };
  }

  public getBlobStorageService(): BlobStorageService {
    return this.blobService;
  }
}
