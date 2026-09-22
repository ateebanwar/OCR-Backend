/**
 * Centralized Typed Error Architecture
 * Standardized across all layers, preventing raw internal/SDK leakages.
 */

export abstract class AppError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly code: string;
  public readonly isOperational: boolean = true;
  public readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConfigurationError extends AppError {
  public readonly statusCode = 500;
  public readonly code = 'CONFIGURATION_ERROR';
}

export class FileValidationError extends AppError {
  public readonly statusCode = 400;
  public readonly code = 'FILE_VALIDATION_ERROR';
}

export class UnsupportedDocumentError extends AppError {
  public readonly statusCode = 415;
  public readonly code = 'UNSUPPORTED_DOCUMENT_TYPE';
}

export class ValidationError extends AppError {
  public readonly statusCode = 422;
  public readonly code = 'VALIDATION_FAILED';
}

export class ExtractionError extends AppError {
  public readonly statusCode = 422;
  public readonly code = 'EXTRACTION_FAILED';
}

export class ReconciliationError extends AppError {
  public readonly statusCode = 422;
  public readonly code = 'RECONCILIATION_FAILED';
}

export class ProviderError extends AppError {
  public readonly statusCode = 502;
  public readonly code = 'AI_PROVIDER_ERROR';
}

export class ProviderTimeoutError extends AppError {
  public readonly statusCode = 504;
  public readonly code = 'AI_PROVIDER_TIMEOUT';
}

export class SpreadsheetGenerationError extends AppError {
  public readonly statusCode = 500;
  public readonly code = 'SPREADSHEET_GENERATION_FAILED';
}

export class DocumentProcessingError extends AppError {
  public readonly statusCode = 422;
  public readonly code = 'DOCUMENT_PROCESSING_FAILED';
}
