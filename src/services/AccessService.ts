import crypto from 'node:crypto';
import { AppConfig } from '../config/env';

export interface TokenVerificationResult {
  valid: boolean;
  reason?: 'INVALID_TOKEN_FORMAT' | 'INVALID_SIGNATURE' | 'EXPIRED' | 'MALFORMED_PAYLOAD';
  payload?: Record<string, unknown>;
}

export class AccessService {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Reports whether password authentication is currently required.
   */
  public isPasswordRequired(): boolean {
    return this.config.requirePassword;
  }

  /**
   * Verifies the provided password against the server-configured ACCESS_PASSWORD in constant time.
   * Prevents timing attacks and never logs or leaks the configured or submitted password.
   */
  public verifyPassword(inputPassword: string): boolean {
    if (!this.config.accessPassword || typeof inputPassword !== 'string') {
      return false;
    }

    const inputBuf = Buffer.from(inputPassword, 'utf8');
    const expectedBuf = Buffer.from(this.config.accessPassword, 'utf8');

    if (inputBuf.length !== expectedBuf.length) {
      // Execute dummy constant-time comparison on inputBuf to prevent timing leakage
      crypto.timingSafeEqual(inputBuf, inputBuf);
      return false;
    }

    return crypto.timingSafeEqual(inputBuf, expectedBuf);
  }

  /**
   * Derives a cryptographic signing secret dynamically.
   * Derived from: HMAC(ACCESS_TOKEN_SECRET, ACCESS_PASSWORD + ":" + ACCESS_AUTH_VERSION).
   * 
   * CRITICAL SECURITY BEHAVIOR:
   * When ACCESS_PASSWORD changes on the server, the derived signing secret changes immediately.
   * Consequently, all previously issued access tokens fail HMAC signature verification statelessly,
   * with zero database or Redis required.
   */
  private getSigningSecret(): Buffer {
    const pw = this.config.accessPassword || '';
    const ver = this.config.accessAuthVersion || '1';
    return crypto
      .createHmac('sha256', this.config.accessTokenSecret)
      .update(`${pw}:${ver}`)
      .digest();
  }

  /**
   * Parses configurable TTL strings like '30m', '1h', '60s' or numeric seconds into seconds.
   */
  public parseTtlSeconds(ttl: string | number): number {
    if (typeof ttl === 'number') {
      return ttl > 0 ? ttl : 1800;
    }

    const trimmed = ttl.trim().toLowerCase();
    const match = trimmed.match(/^(\d+)([smhd])?$/);
    if (!match || !match[1]) {
      return 1800; // default 30 minutes
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return value;
    }
  }

  /**
   * Generates a stateless, cryptographically signed short-lived access token in compact JWT format.
   * Contains NO password, NO personal profile data, and NO Gemini API keys.
   */
  public generateAccessToken(customClaims?: Record<string, unknown>): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const ttlSec = this.parseTtlSeconds(this.config.accessTokenTtl);

    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      sub: 'access-gate',
      iat: nowSec,
      exp: nowSec + ttlSec,
      ver: this.config.accessAuthVersion,
      ...customClaims,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const dataToSign = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto
      .createHmac('sha256', this.getSigningSecret())
      .update(dataToSign)
      .digest('base64url');

    return `${dataToSign}.${signature}`;
  }

  /**
   * Validates the access token:
   * 1. Checks format.
   * 2. Re-computes and checks HMAC-SHA256 signature in constant time against current derived secret.
   * 3. Checks expiration timestamp.
   */
  public verifyAccessToken(token: string): TokenVerificationResult {
    if (!token || typeof token !== 'string') {
      return { valid: false, reason: 'INVALID_TOKEN_FORMAT' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'INVALID_TOKEN_FORMAT' };
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    if (!encodedHeader || !encodedPayload || !signature) {
      return { valid: false, reason: 'INVALID_TOKEN_FORMAT' };
    }

    const dataToSign = `${encodedHeader}.${encodedPayload}`;

    const expectedSignature = crypto
      .createHmac('sha256', this.getSigningSecret())
      .update(dataToSign)
      .digest('base64url');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expSigBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expSigBuf.length || !crypto.timingSafeEqual(sigBuf, expSigBuf)) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      return { valid: false, reason: 'MALFORMED_PAYLOAD' };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && typeof payload.exp === 'number' && payload.exp < nowSec) {
      return { valid: false, reason: 'EXPIRED' };
    }

    return { valid: true, payload };
  }
}
