/**
 * High-Precision Decimal Math Utility for Safe Monetary Calculations.
 * Avoids IEEE-754 floating-point inaccuracies (e.g., 0.1 + 0.2 !== 0.3)
 * by storing numbers as scaled BigInt with 6 fixed decimal places of precision.
 */

export class Decimal {
  private static readonly SCALE = 6;
  private static readonly MULTIPLIER = 1_000_000n;

  private readonly value: bigint;

  private constructor(scaledBigInt: bigint) {
    this.value = scaledBigInt;
  }

  public static from(val: number | string | bigint | null | undefined): Decimal {
    if (val === null || val === undefined || val === '') {
      return new Decimal(0n);
    }

    if (typeof val === 'bigint') {
      return new Decimal(val * Decimal.MULTIPLIER);
    }

    if (typeof val === 'number') {
      if (isNaN(val) || !isFinite(val)) {
        return new Decimal(0n);
      }
      // Convert to fixed string to prevent float representation quirks
      const fixedStr = val.toFixed(Decimal.SCALE);
      return Decimal.fromString(fixedStr);
    }

    return Decimal.fromString(String(val).trim());
  }

  private static fromString(str: string): Decimal {
    // Clean string: remove currency signs, spaces, thousand-separators (commas)
    const cleaned = str
      .replace(/[^0-9.-]/g, '')
      .replace(/(?!^)-/g, ''); // keep only leading minus

    if (!cleaned || cleaned === '-' || cleaned === '.') {
      return new Decimal(0n);
    }

    const isNegative = cleaned.startsWith('-');
    const unsignedStr = isNegative ? cleaned.slice(1) : cleaned;

    const parts = unsignedStr.split('.');
    const integerPart = parts[0] || '0';
    let fractionPart = parts[1] || '';

    // Pad or truncate fraction to 6 places
    if (fractionPart.length > Decimal.SCALE) {
      fractionPart = fractionPart.slice(0, Decimal.SCALE);
    } else {
      fractionPart = fractionPart.padEnd(Decimal.SCALE, '0');
    }

    const totalBigInt = BigInt(integerPart) * Decimal.MULTIPLIER + BigInt(fractionPart);
    return new Decimal(isNegative ? -totalBigInt : totalBigInt);
  }

  public add(other: Decimal | number): Decimal {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    return new Decimal(this.value + o.value);
  }

  public subtract(other: Decimal | number): Decimal {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    return new Decimal(this.value - o.value);
  }

  public multiply(other: Decimal | number): Decimal {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    // (a * b) / MULTIPLIER
    const product = (this.value * o.value) / Decimal.MULTIPLIER;
    return new Decimal(product);
  }

  public divide(other: Decimal | number): Decimal {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    if (o.value === 0n) {
      return new Decimal(0n);
    }
    const quotient = (this.value * Decimal.MULTIPLIER) / o.value;
    return new Decimal(quotient);
  }

  public abs(): Decimal {
    return new Decimal(this.value < 0n ? -this.value : this.value);
  }

  public isZero(): boolean {
    return this.value === 0n;
  }

  public isNegative(): boolean {
    return this.value < 0n;
  }

  public toNumber(): number {
    const isNeg = this.value < 0n;
    const unsigned = isNeg ? -this.value : this.value;
    const intPart = unsigned / Decimal.MULTIPLIER;
    const fracPart = unsigned % Decimal.MULTIPLIER;
    const num = Number(intPart) + Number(fracPart) / Number(Decimal.MULTIPLIER);
    return isNeg ? -num : num;
  }

  public toFixed(fractionDigits = 2): string {
    const isNeg = this.value < 0n;
    const unsigned = isNeg ? -this.value : this.value;
    const intPart = unsigned / Decimal.MULTIPLIER;
    const fracPart = unsigned % Decimal.MULTIPLIER;

    // Scale fraction to requested digits
    const paddedFrac = fracPart.toString().padStart(Decimal.SCALE, '0');
    const sliced = paddedFrac.slice(0, fractionDigits);
    
    // Check rounding if next digit >= 5
    const nextDigit = parseInt(paddedFrac[fractionDigits] || '0', 10);
    let finalFrac = parseInt(sliced || '0', 10);
    let finalInt = intPart;

    if (nextDigit >= 5) {
      finalFrac += 1;
      if (finalFrac >= Math.pow(10, fractionDigits)) {
        finalFrac = 0;
        finalInt += 1n;
      }
    }

    const fracStr = fractionDigits > 0 ? `.${finalFrac.toString().padStart(fractionDigits, '0')}` : '';
    const sign = isNeg ? '-' : '';
    return `${sign}${finalInt.toString()}${fracStr}`;
  }

  public isWithinTolerance(other: Decimal | number, tolerance = 0.02): boolean {
    const diff = this.subtract(other).abs();
    const tol = Decimal.from(tolerance);
    return diff.value <= tol.value;
  }

  public equals(other: Decimal | number): boolean {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    return this.value === o.value;
  }
}
