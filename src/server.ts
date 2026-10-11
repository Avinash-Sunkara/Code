import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/db';
import { logger } from './config/logger';
import { ensureAdmin } from './services/bootstrap';
import { startJobs } from './jobs/cleanup';

async function main() {
  await prisma.$connect();
  await ensureAdmin();
  startJobs();
  const server = createApp().listen(env.PORT, '0.0.0.0', () => logger.info(`API listening on ${env.PORT}`));
  const stop = async (sig: string) => {
    logger.info({ sig }, 'shutting down');
    server.close(async () => { await prisma.$disconnect(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
main().catch((err) => { logger.fatal({ err }, 'failed to start'); process.exit(1); });
