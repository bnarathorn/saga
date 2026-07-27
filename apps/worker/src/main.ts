import { errorMessage } from '@saga/shared';
import { loadConfig } from '@saga/shared/config';
import { loadDotEnv } from '@saga/shared/dotenv';
import { buildWorkerContext } from './context.js';
import { registerHandlers, startMaintenance } from './register.js';
import { Worker } from './worker.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const ctx = buildWorkerContext({ config });

  registerHandlers(ctx);

  const worker = new Worker({
    pool: ctx.pool,
    jobs: ctx.services.jobs,
    services: ctx.repositories.services,
    registry: ctx.handlers,
    logger: ctx.logger,
    version: config.version,
    concurrency: config.worker.concurrency,
    pollIntervalMs: config.worker.pollIntervalMs,
    leaseSeconds: config.worker.jobLeaseSeconds,
    serviceLeaseSeconds: config.worker.serviceLeaseSeconds,
    heartbeatIntervalMs: config.worker.heartbeatIntervalMs,
  });

  const stopMaintenance = startMaintenance(ctx);
  await worker.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.logger.info({ signal }, 'shutting down worker');
    stopMaintenance();
    try {
      await worker.stop();
    } catch (error) {
      ctx.logger.error({ err: error }, 'error while stopping worker');
    } finally {
      await ctx.shutdown();
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
