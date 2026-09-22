/**
 * High-Precision Decimal Math Engine for Deterministic Financial Computations.
 * Eliminates IEEE-754 binary floating-point representation bugs (such as 0.1 + 0.2 !== 0.3)
 * by storing currency values as integer BigInt scaled to 8 fixed decimal places.
 *
 * Implements strict financial Round Half-Up (GAAP / IFRS / ISO 10967-2 compliant).
 */

export class Decimal {
  public static readonly SCALE = 8;
  public static readonly MULTIPLIER = 100_000_000n;

  private readonly value: bigint;

  private constructor(scaledBigInt: bigint) {
    this.value = scaledBigInt;
  }

  /**
   * Internal constructor helper
   */
  public static fromScaledBigInt(scaled: bigint): Decimal {
    return new Decimal(scaled);
  }

  /**
   * Parses number, string, bigint, null, or undefined into a high-precision Decimal.
   */
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
      // Format to fixed string with full scale to avoid float parsing artifacts
      const fixedStr = val.toFixed(Decimal.SCALE);
      return Decimal.fromString(fixedStr);
    }

    return Decimal.fromString(String(val).trim());
  }

  private static fromString(str: string): Decimal {
    // Clean string: remove currency symbols ($ € £ ¥ ₹ etc.), spaces, commas
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

    // Pad or truncate fraction to SCALE places
    if (fractionPart.length > Decimal.SCALE) {
      fractionPart = fractionPart.slice(0, Decimal.SCALE);
    } else {
      fractionPart = fractionPart.padEnd(Decimal.SCALE, '0');
    }

    const totalBigInt = BigInt(integerPart) * Decimal.MULTIPLIER + BigInt(fractionPart);
    return new Decimal(isNegative ? -totalBigInt : totalBigInt);
  }

  public add(other: Decimal | number | string): Decimal {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    return new Decimal(this.value + o.value);
  }

  public subtract(other: Decimal | number | string): Decimal {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    return new Decimal(this.value - o.value);
  }

  /**
   * Exact multiplication with symmetric Round Half-Up on the remainder.
   */
  public multiply(other: Decimal | number | string): Decimal {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    const isNeg = (this.value < 0n) !== (o.value < 0n);
    const absA = this.value < 0n ? -this.value : this.value;
    const absB = o.value < 0n ? -o.value : o.value;

    const raw = absA * absB;
    const rounded = (raw + Decimal.MULTIPLIER / 2n) / Decimal.MULTIPLIER;
    return new Decimal(isNeg ? -rounded : rounded);
  }

  /**
   * Exact division with symmetric Round Half-Up on the remainder.
   */
  public divide(other: Decimal | number | string): Decimal {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    if (o.value === 0n) {
      return new Decimal(0n);
    }
    const isNeg = (this.value < 0n) !== (o.value < 0n);
    const absA = this.value < 0n ? -this.value : this.value;
    const absB = o.value < 0n ? -o.value : o.value;

    const numerator = absA * Decimal.MULTIPLIER;
    const quotient = (numerator + absB / 2n) / absB;
    return new Decimal(isNeg ? -quotient : quotient);
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

  public isPositive(): boolean {
    return this.value > 0n;
  }

  /**
   * Deterministically rounds to the specified currency precision using Round Half-Up.
   */
  public roundTo(precision: number): Decimal {
    if (precision >= Decimal.SCALE) {
      return this;
    }
    const safePrecision = Math.max(0, precision);
    const factor = 10n ** BigInt(Decimal.SCALE - safePrecision);
    const half = factor / 2n;
    const isNeg = this.value < 0n;
    const absVal = isNeg ? -this.value : this.value;
    const rounded = ((absVal + half) / factor) * factor;
    return new Decimal(isNeg ? -rounded : rounded);
  }

  /**
   * Strict equality comparison across all internal decimal places.
   */
  public equals(other: Decimal | number | string): boolean {
    const o = other instanceof Decimal ? other : Decimal.from(other);
    return this.value === o.value;
  }

  /**
   * Strict equality comparison after rounding both operands to the designated currency precision.
   */
  public equalsAtPrecision(other: Decimal | number | string, precision: number): boolean {
    const a = this.roundTo(precision);
    const b = (other instanceof Decimal ? other : Decimal.from(other)).roundTo(precision);
    return a.value === b.value;
  }

  /**
   * Returns absolute difference between this and another Decimal.
   */
  public diff(other: Decimal | number | string): Decimal {
    return this.subtract(other).abs();
  }

  /**
   * Tolerance check helper (explicit tolerance required; no blind default).
   */
  public isWithinTolerance(other: Decimal | number | string, tolerance: number): boolean {
    const diff = this.subtract(other).abs();
    const tol = Decimal.from(tolerance);
    return diff.value <= tol.value;
  }

  public toNumber(): number {
    const isNeg = this.value < 0n;
    const unsigned = isNeg ? -this.value : this.value;
    const intPart = unsigned / Decimal.MULTIPLIER;
    const fracPart = unsigned % Decimal.MULTIPLIER;
    const num = Number(intPart) + Number(fracPart) / Number(Decimal.MULTIPLIER);
    return isNeg ? -num : num;
  }

  /**
   * Formats the Decimal to fixed decimal places with Round Half-Up.
   */
  public toFixed(fractionDigits = 2): string {
    const safeDigits = Math.max(0, fractionDigits);
    const rounded = this.roundTo(safeDigits);
    const isNeg = rounded.value < 0n;
    const unsigned = isNeg ? -rounded.value : rounded.value;
    const intPart = unsigned / Decimal.MULTIPLIER;
    const fracPart = unsigned % Decimal.MULTIPLIER;

    const paddedFrac = fracPart.toString().padStart(Decimal.SCALE, '0');
    const slicedFrac = safeDigits > 0 ? `.${paddedFrac.slice(0, safeDigits)}` : '';
    const sign = isNeg ? '-' : '';

    return `${sign}${intPart.toString()}${slicedFrac}`;
  }
}
