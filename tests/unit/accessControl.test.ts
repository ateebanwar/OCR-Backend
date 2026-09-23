import { describe, it, expect, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app/buildApp';
import { loadConfig } from '../../src/config/env';
import { MockAIProvider } from '../mocks/MockAIProvider';
import { AccessService } from '../../src/services/AccessService';
import { ConfigurationError } from '../../src/errors/AppError';

describe('Secure Password Access Gate & Access Control Suite', () => {
  const validPdfContent = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
  );

  const createMultipartPayload = (filename: string = 'invoice.pdf') => {
    const boundary = '----AccessGateTestBoundary';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`),
      validPdfContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { boundary, multipartBody };
  };

  describe('1. Configuration & Fail-Safe Startup', () => {
    it('throws ConfigurationError when REQUIRE_PASSWORD=true but ACCESS_PASSWORD is missing or empty', () => {
      expect(() => {
        loadConfig({
          NODE_ENV: 'test',
          REQUIRE_PASSWORD: 'true',
          ACCESS_PASSWORD: '',
        });
      }).toThrowError(/ACCESS_PASSWORD is required when REQUIRE_PASSWORD=true/);

      expect(() => {
        loadConfig({
          NODE_ENV: 'test',
          REQUIRE_PASSWORD: 'true',
          ACCESS_PASSWORD: '   ',
        });
      }).toThrowError(ConfigurationError);
    });

    it('throws ConfigurationError in production if REQUIRE_PASSWORD=true but ACCESS_TOKEN_SECRET is missing', () => {
      expect(() => {
        loadConfig({
          NODE_ENV: 'production',
          REQUIRE_PASSWORD: 'true',
          ACCESS_PASSWORD: 'SuperSecretPassword123!',
          ACCESS_TOKEN_SECRET: '',
        });
      }).toThrowError(/ACCESS_TOKEN_SECRET must be configured in production/);
    });

    it('loads successfully when REQUIRE_PASSWORD=false without ACCESS_PASSWORD', () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'false',
      });
      expect(config.requirePassword).toBe(false);
      expect(config.accessPassword).toBeUndefined();
    });
  });

  describe('2. Public Status Endpoint (GET /api/v1/access/status)', () => {
    it('returns passwordRequired: true when REQUIRE_PASSWORD=true without leaking any secrets', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: 'MySecretPassword123',
        ACCESS_TOKEN_SECRET: 'test-secret-key-32-bytes-long-12345',
      });
      const app = await buildApp({ config, aiProvider: new MockAIProvider() });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/access/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.passwordRequired).toBe(true);
      expect(body.data.password).toBeUndefined();
      expect(body.data.accessPassword).toBeUndefined();
      expect(body.data.secret).toBeUndefined();

      const rawText = response.body;
      expect(rawText).not.toContain('MySecretPassword123');
      expect(rawText).not.toContain('test-secret-key-32-bytes-long-12345');

      await app.close();
    });

    it('returns passwordRequired: false when REQUIRE_PASSWORD=false', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'false',
      });
      const app = await buildApp({ config, aiProvider: new MockAIProvider() });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/access/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.passwordRequired).toBe(false);

      await app.close();
    });
  });

  describe('3. Password Verification Endpoint (POST /api/v1/access/verify)', () => {
    let app: FastifyInstance;
    const testPassword = 'CorrectAccessPassword2026!';
    const testSecret = 'test-signing-secret-minimum-32-bytes-long!';

    afterAll(async () => {
      if (app) await app.close();
    });

    it('succeeds with correct password and returns a valid accessToken', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: testPassword,
        ACCESS_TOKEN_SECRET: testSecret,
      });
      app = await buildApp({ config, aiProvider: new MockAIProvider() });
      await app.ready();

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: {
          name: 'Jane Doe',
          dob: '1990-01-01',
          gender: 'Female',
          email: 'jane@example.com',
          password: testPassword,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.authenticated).toBe(true);
      expect(typeof body.data.accessToken).toBe('string');
      expect(body.data.accessToken.split('.').length).toBe(3);

      // Verify token payload does NOT contain password, Gemini key, or user personal info
      const tokenParts = body.data.accessToken.split('.');
      const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString('utf8'));
      expect(payload.password).toBeUndefined();
      expect(payload.geminiApiKey).toBeUndefined();
      expect(payload.email).toBeUndefined();
      expect(payload.name).toBeUndefined();
      expect(payload.sub).toBe('access-gate');
      expect(payload.exp).toBeGreaterThan(payload.iat);

      // Verify raw response never leaks the password
      expect(response.body).not.toContain(testPassword);
      expect(response.body).not.toContain(testSecret);
    });

    it('fails with wrong password and returns generic 401 INVALID_ACCESS_PASSWORD without leaking secrets', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: {
          name: 'Jane Doe',
          email: 'jane@example.com',
          password: 'IncorrectPassword!',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_ACCESS_PASSWORD');
      expect(body.error.message).toBe('Invalid access credentials.');

      // Response must never reveal expected password or partial match hints
      expect(response.body).not.toContain(testPassword);
      expect(response.body).not.toContain('CorrectAccessPassword');
    });

    it('rejects empty or missing password with 422 VALIDATION_FAILED', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: {
          name: 'Jane Doe',
          password: '',
        },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('4. Protected Endpoints Authorization Enforcement', () => {
    let app: FastifyInstance;
    let validToken: string;
    const testPassword = 'ProtectedEndpointPassword2026!';
    const testSecret = 'secret-signing-key-for-auth-enforcement!';

    afterAll(async () => {
      if (app) await app.close();
    });

    it('initializes app with REQUIRE_PASSWORD=true and obtains valid token', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: testPassword,
        ACCESS_TOKEN_SECRET: testSecret,
      });
      app = await buildApp({ config, aiProvider: new MockAIProvider() });
      await app.ready();

      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: { password: testPassword },
      });
      expect(verifyRes.statusCode).toBe(200);
      validToken = JSON.parse(verifyRes.body).data.accessToken;
      expect(validToken).toBeDefined();
    });

    it('POST /api/v1/documents/process fails with 401 AUTHENTICATION_REQUIRED when Authorization header is missing', async () => {
      const { boundary, multipartBody } = createMultipartPayload();

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody,
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('POST /api/v1/documents/process fails with 401 AUTHENTICATION_REQUIRED when scheme is not Bearer', async () => {
      const { boundary, multipartBody } = createMultipartPayload();

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Basic ${validToken}`,
        },
        payload: multipartBody,
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('POST /api/v1/documents/process fails with 401 INVALID_ACCESS_TOKEN for tampered token', async () => {
      const { boundary, multipartBody } = createMultipartPayload();
      const tamperedToken = validToken.slice(0, -6) + 'abcdef';

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${tamperedToken}`,
        },
        payload: multipartBody,
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INVALID_ACCESS_TOKEN');
    });

    it('POST /api/v1/documents/process succeeds with 200 when valid token is provided', async () => {
      const { boundary, multipartBody } = createMultipartPayload();

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${validToken}`,
        },
        payload: multipartBody,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.data.documentId).toBeDefined();
    });

    it('rejects expired access tokens with 401 INVALID_ACCESS_TOKEN', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: testPassword,
        ACCESS_TOKEN_SECRET: testSecret,
        ACCESS_TOKEN_TTL: '1s',
      });
      const accessService = new AccessService(config);

      // Generate a token that expired 10 seconds ago
      const expiredToken = accessService.generateAccessToken({ exp: Math.floor(Date.now() / 1000) - 10 });

      const { boundary, multipartBody } = createMultipartPayload();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${expiredToken}`,
        },
        payload: multipartBody,
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('INVALID_ACCESS_TOKEN');
    });

    it('protects POST /api/v1/documents/download with authentication', async () => {
      // Without token -> 401
      const resWithoutToken = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/download',
        payload: { xlsxBase64: 'UEsDBBQAAAAIAAA=', filename: 'test.xlsx' },
      });
      expect(resWithoutToken.statusCode).toBe(401);

      // With token -> succeeds or proceeds to payload validation
      const resWithToken = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/download',
        headers: { authorization: `Bearer ${validToken}` },
        payload: { xlsxBase64: 'UEsDBBQAAAAIAAA=', filename: 'test.xlsx' },
      });
      expect(resWithToken.statusCode).toBe(200);
    });

    it('protects POST /api/v1/documents/review with authentication', async () => {
      const resWithoutToken = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/review',
        payload: { reviewToken: 'tok-123', resolutions: [{ issueId: '1', userDecision: 'KEEP_AS_IS' }] },
      });
      expect(resWithoutToken.statusCode).toBe(401);
    });

    it('protects POST /api/v1/chat with authentication', async () => {
      const resWithoutToken = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });
      expect(resWithoutToken.statusCode).toBe(401);

      const resWithToken = await app.inject({
        method: 'POST',
        url: '/api/v1/chat',
        headers: { authorization: `Bearer ${validToken}` },
        payload: { messages: [{ role: 'user', content: 'Hello' }] },
      });
      expect(resWithToken.statusCode).toBe(200);
    });

    it('protects POST /api/v1/documents/chat with authentication', async () => {
      const resWithoutToken = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/chat',
        payload: { documentContext: 'Invoice summary', messages: [{ role: 'user', content: 'What is the total?' }] },
      });
      expect(resWithoutToken.statusCode).toBe(401);

      const resWithToken = await app.inject({
        method: 'POST',
        url: '/api/v1/documents/chat',
        headers: { authorization: `Bearer ${validToken}` },
        payload: { documentContext: 'Invoice summary', messages: [{ role: 'user', content: 'What is the total?' }] },
      });
      expect(resWithToken.statusCode).toBe(200);
    });
  });

  describe('5. Password Rotation & Stateless Token Invalidation', () => {
    const oldPassword = 'OldPassword_v1';
    const newPassword = 'NewPassword_v2';
    const sharedSecret = 'shared-secret-across-deployments-1234567';

    it('changing ACCESS_PASSWORD immediately invalidates OLD password and invalidates tokens issued under OLD password', async () => {
      // Step A: App with OLD password
      const oldConfig = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: oldPassword,
        ACCESS_TOKEN_SECRET: sharedSecret,
        ACCESS_AUTH_VERSION: '1',
      });
      const oldApp = await buildApp({ config: oldConfig, aiProvider: new MockAIProvider() });
      await oldApp.ready();

      // Authenticate with old password
      const loginResOld = await oldApp.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: { password: oldPassword },
      });
      expect(loginResOld.statusCode).toBe(200);
      const oldToken = JSON.parse(loginResOld.body).data.accessToken;

      // Verify token works on old app
      const { boundary, multipartBody } = createMultipartPayload();
      const oldVerifyRes = await oldApp.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${oldToken}`,
        },
        payload: multipartBody,
      });
      expect(oldVerifyRes.statusCode).toBe(200);
      await oldApp.close();

      // Step B: Reload / redeploy app with NEW password
      const newConfig = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: newPassword,
        ACCESS_TOKEN_SECRET: sharedSecret,
        ACCESS_AUTH_VERSION: '1',
      });
      const newApp = await buildApp({ config: newConfig, aiProvider: new MockAIProvider() });
      await newApp.ready();

      // 1. OLD password MUST fail on new app
      const failedLoginRes = await newApp.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: { password: oldPassword },
      });
      expect(failedLoginRes.statusCode).toBe(401);
      expect(JSON.parse(failedLoginRes.body).error.code).toBe('INVALID_ACCESS_PASSWORD');

      // 2. NEW password MUST succeed on new app
      const successfulLoginRes = await newApp.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: { password: newPassword },
      });
      expect(successfulLoginRes.statusCode).toBe(200);
      const newToken = JSON.parse(successfulLoginRes.body).data.accessToken;

      // 3. Token issued under OLD password MUST be rejected by new app (Stateless Cryptographic Invalidation)
      const oldTokenOnNewApp = await newApp.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${oldToken}`,
        },
        payload: multipartBody,
      });
      expect(oldTokenOnNewApp.statusCode).toBe(401);
      expect(JSON.parse(oldTokenOnNewApp.body).error.code).toBe('INVALID_ACCESS_TOKEN');

      // 4. Token issued under NEW password MUST work
      const newTokenOnNewApp = await newApp.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${newToken}`,
        },
        payload: multipartBody,
      });
      expect(newTokenOnNewApp.statusCode).toBe(200);

      await newApp.close();
    });

    it('bumping ACCESS_AUTH_VERSION invalidates previously issued tokens even when password remains unchanged', async () => {
      const v1Config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: 'UnchangedPassword123!',
        ACCESS_TOKEN_SECRET: sharedSecret,
        ACCESS_AUTH_VERSION: '1',
      });
      const v1App = await buildApp({ config: v1Config, aiProvider: new MockAIProvider() });
      await v1App.ready();

      const v1Login = await v1App.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: { password: 'UnchangedPassword123!' },
      });
      const v1Token = JSON.parse(v1Login.body).data.accessToken;
      await v1App.close();

      // Bump version to 2
      const v2Config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: 'UnchangedPassword123!',
        ACCESS_TOKEN_SECRET: sharedSecret,
        ACCESS_AUTH_VERSION: '2',
      });
      const v2App = await buildApp({ config: v2Config, aiProvider: new MockAIProvider() });
      await v2App.ready();

      // v1 token fails on v2 deployment
      const { boundary, multipartBody } = createMultipartPayload();
      const testRes = await v2App.inject({
        method: 'POST',
        url: '/api/v1/documents/process',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${v1Token}`,
        },
        payload: multipartBody,
      });
      expect(testRes.statusCode).toBe(401);
      expect(JSON.parse(testRes.body).error.code).toBe('INVALID_ACCESS_TOKEN');

      await v2App.close();
    });
  });

  describe('6. Rate Limiting on Access Verification', () => {
    it('enforces rate limit on POST /api/v1/access/verify after configured maximum attempts', async () => {
      const config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: 'RateLimitPassword',
        ACCESS_TOKEN_SECRET: 'rate-limit-test-secret-1234567890',
        ACCESS_RATE_LIMIT_MAX: '3',
        ACCESS_RATE_LIMIT_WINDOW_MS: '60000',
      });
      const app = await buildApp({ config, aiProvider: new MockAIProvider() });
      await app.ready();

      // 3 attempts succeed or fail with 401
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/access/verify',
          payload: { password: 'wrong' },
        });
        expect(res.statusCode).toBe(401);
      }

      // 4th attempt exceeds max limit -> 429 RATE_LIMIT_EXCEEDED
      const limitedRes = await app.inject({
        method: 'POST',
        url: '/api/v1/access/verify',
        payload: { password: 'wrong' },
      });
      expect(limitedRes.statusCode).toBe(429);
      const body = JSON.parse(limitedRes.body);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');

      await app.close();
    });
  });

  describe('7. Health Endpoint Safety', () => {
    it('GET /api/v1/health never exposes passwords or secrets', async () => {
      const secretPw = 'DoNotLeakThisSecretPassword!';
      const config = loadConfig({
        NODE_ENV: 'test',
        REQUIRE_PASSWORD: 'true',
        ACCESS_PASSWORD: secretPw,
        ACCESS_TOKEN_SECRET: 'SuperSecretTokenSigningKey!',
      });
      const app = await buildApp({ config, aiProvider: new MockAIProvider() });
      await app.ready();

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(secretPw);
      expect(response.body).not.toContain('SuperSecretTokenSigningKey');

      await app.close();
    });
  });
});
