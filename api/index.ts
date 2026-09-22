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
  const app = await getApp();
  app.server.emit('request', req, res);
}
