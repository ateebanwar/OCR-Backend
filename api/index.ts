import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../src/app/buildApp';
import { getConfig } from '../src/config/env';
import { FastifyInstance } from 'fastify';

let cachedApp: FastifyInstance | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (!cachedApp) {
    const config = getConfig();
    const app = await buildApp({ config });
    await app.ready();
    cachedApp = app;
  }
  return cachedApp;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Ensure socket remoteAddress is always populated for proxy/serverless environments
  if (!req.socket) {
    (req as any).socket = { remoteAddress: '127.0.0.1' };
  } else if (!req.socket.remoteAddress) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string'
      ? forwarded.split(',')[0]?.trim()
      : typeof req.headers['x-real-ip'] === 'string'
      ? req.headers['x-real-ip']
      : '127.0.0.1';
    (req.socket as any).remoteAddress = ip;
  }

  try {
    const app = await getApp();
    await new Promise<void>((resolve, reject) => {
      res.on('finish', () => resolve());
      res.on('close', () => resolve());
      res.on('error', (err) => reject(err));
      app.server.emit('request', req, res);
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Vercel Serverless Function Error:', message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'SERVER_CONFIGURATION_ERROR',
            message: `Server startup or invocation failed: ${message}`,
          },
        })
      );
    }
  }
}
