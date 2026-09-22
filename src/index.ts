import { startServer } from './app/server';

export { buildApp } from './app/buildApp';
export { getConfig } from './config/env';
export * from './domain/financial';
export * from './domain/processing';
export * from './domain/chat';

// Run server when started directly
if (require.main === module || process.env.NODE_ENV !== 'test') {
  startServer().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
