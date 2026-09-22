import { rawFinancialExtractionSchema, RawFinancialExtraction } from '../extraction/schemas/financialSchema';
import { ValidationError } from '../errors/AppError';

export interface StructuralValidationResult {
  isValid: boolean;
  data: RawFinancialExtraction | null;
  errors: string[];
}

export function validateStructure(rawData: unknown): StructuralValidationResult {
  const result = rawFinancialExtractionSchema.safeParse(rawData);

  if (!result.success) {
    const errors = result.error.errors.map(err => {
      const path = err.path.join('.');
      return `${path ? `[${path}] ` : ''}${err.message}`;
    });

    return {
      isValid: false,
      data: null,
      errors,
    };
  }

  return {
    isValid: true,
    data: result.data,
    errors: [],
  };
}

export function assertValidStructure(rawData: unknown): RawFinancialExtraction {
  const result = validateStructure(rawData);
  if (!result.isValid || !result.data) {
    throw new ValidationError(
      `Structural validation failed: ${result.errors.join('; ')}`,
      result.errors
    );
  }
  return result.data;
}
