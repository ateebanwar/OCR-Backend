import { describe, it, expect } from 'vitest';
import { rawFinancialExtractionSchema } from '../../src/extraction/schemas/financialSchema';
import { assertValidStructure, validateStructure } from '../../src/validation/structuralValidator';

describe('Financial Zod Schemas', () => {
  it('successfully validates a complete canonical payload', () => {
    const payload = {
      documentType: 'invoice',
      invoiceNumber: 'INV-2024-99',
      invoiceDate: '2024-03-01',
      currency: 'USD',
      totals: {
        grandTotal: 500.0,
      },
      lineItems: [
        {
          description: 'Consulting Services',
          quantity: 5,
          unitPrice: 100.0,
          lineTotal: 500.0,
        },
      ],
    };

    const result = validateStructure(payload);
    expect(result.isValid).toBe(true);
    expect(result.data?.lineItems.length).toBe(1);
    expect(result.data?.totals.grandTotal).toBe(500.0);
  });

  it('fails validation when grandTotal is missing', () => {
    const invalidPayload = {
      documentType: 'invoice',
      totals: {},
      lineItems: [],
    };

    const result = validateStructure(invalidPayload);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('grandTotal'))).toBe(true);
  });

  it('fails validation when line item description is empty', () => {
    const invalidPayload = {
      totals: { grandTotal: 100 },
      lineItems: [
        {
          description: '',
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
        },
      ],
    };

    const result = validateStructure(invalidPayload);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('description'))).toBe(true);
  });

  it('assertValidStructure throws ValidationError when invalid', () => {
    expect(() => assertValidStructure({})).toThrowError(/Structural validation failed/);
  });
});
