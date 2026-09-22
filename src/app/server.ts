import { buildApp } from './buildApp';
import { getConfig } from '../config/env';

export async function startServer(): Promise<void> {
  const config = getConfig();
  const app = await buildApp({ config });

  try {
    const address = await app.listen({
      port: config.port,
      host: config.host,
    });
    app.log.info(`Financial Document Intelligence Backend listening on ${address}`);
  } catch (err: unknown) {
    app.log.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}. Shutting down gracefully...`);
    try {
      await app.close();
      app.log.info('Server closed successfully.');
      process.exit(0);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error during server shutdown.');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
