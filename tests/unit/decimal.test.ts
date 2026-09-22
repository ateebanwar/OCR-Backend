import { describe, it, expect } from 'vitest';
import { Decimal } from '../../src/reconciliation/decimal';

describe('Decimal Monetary Math', () => {
  it('correctly handles floating point addition that fails in standard IEEE-754 (0.1 + 0.2)', () => {
    const a = Decimal.from(0.1);
    const b = Decimal.from(0.2);
    const sum = a.add(b);

    expect(sum.toNumber()).toBe(0.3);
    expect(sum.toFixed(2)).toBe('0.30');
  });

  it('preserves exact decimal values and does not round prematurely', () => {
    const val = Decimal.from('1250.55');
    expect(val.toFixed(2)).toBe('1250.55');
    expect(val.toNumber()).toBe(1250.55);
  });

  it('handles negative numbers and credit amounts', () => {
    const positive = Decimal.from('100.00');
    const negative = Decimal.from('-35.50');
    const result = positive.add(negative);

    expect(result.toFixed(2)).toBe('64.50');
    expect(negative.isNegative()).toBe(true);
    expect(positive.isNegative()).toBe(false);
  });

  it('performs exact multiplication for quantity and unit price', () => {
    const qty = Decimal.from('2.5'); // 2.5 hours
    const price = Decimal.from('75.20');
    const total = qty.multiply(price);

    expect(total.toFixed(2)).toBe('188.00');
  });

  it('handles large monetary amounts safely without overflow', () => {
    const large1 = Decimal.from('987654321.50');
    const large2 = Decimal.from('123456789.25');
    const sum = large1.add(large2);

    expect(sum.toFixed(2)).toBe('1111111110.75');
  });

  it('correctly evaluates tolerance for acceptable rounding', () => {
    const a = Decimal.from('100.01');
    const b = Decimal.from('100.00');

    expect(a.isWithinTolerance(b, 0.02)).toBe(true);
    expect(a.isWithinTolerance(b, 0.005)).toBe(false);
  });

  it('handles null, undefined, and empty string safely as zero', () => {
    expect(Decimal.from(null).toNumber()).toBe(0);
    expect(Decimal.from(undefined).toNumber()).toBe(0);
    expect(Decimal.from('').toNumber()).toBe(0);
  });
});
