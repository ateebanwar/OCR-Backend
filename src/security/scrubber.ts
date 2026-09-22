/**
 * Secret & Sensitive Data Scrubber
 * Ensures API keys, tokens, and raw document payloads are never logged or exposed in responses.
 */

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z-_]{20,}/g, // Google API keys
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /sk-[a-zA-Z0-9]{20,}/g, // OpenAI/Claude-style keys
  /key-[a-zA-Z0-9]{20,}/g,
];

export function scrubString(str: string): string {
  let scrubbed = str;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[REDACTED_SECRET]');
  }
  return scrubbed;
}

export function scrubObject<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return scrubString(obj) as unknown as T;
  }

  if (Buffer.isBuffer(obj)) {
    return `[BUFFER size=${obj.length} bytes]` as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => scrubObject(item)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    const scrubbed: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(record)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('key') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('password') ||
        lowerKey.includes('auth')
      ) {
        scrubbed[key] = '[REDACTED]';
      } else if (lowerKey === 'buffer' || lowerKey === 'filedata' || lowerKey === 'base64') {
        scrubbed[key] = '[BINARY_DATA_REDACTED]';
      } else {
        scrubbed[key] = scrubObject(value);
      }
    }
    return scrubbed as T;
  }

  return obj;
}
