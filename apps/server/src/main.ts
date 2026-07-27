import { hostname } from 'node:os';
import { loadConfig } from '@saga/shared/config';
import { errorMessage } from '@saga/shared';
import { loadDotEnv } from '@saga/shared/dotenv';
import { assertProductionSafety, buildApp } from './app.js';
import { buildContext } from './composition.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const ctx = buildContext({ config, role: 'api' });
  assertProductionSafety(ctx);

  const instanceKey = `${hostname()}:${process.pid}`;

  // Create the bootstrap administrator before the port opens so a fresh install is usable
  // without a manual step. It is a no-op once any user exists.
  if (
    config.security.bootstrapAdminEmail.length > 0 &&
    config.security.bootstrapAdminPassword.length > 0
  ) {
    const created = await ctx.services.auth.bootstrapAdmin({
      email: config.security.bootstrapAdminEmail,
      password: config.security.bootstrapAdminPassword,
    });
    if (created !== null) {
      ctx.logger.info({ email: created.email }, 'created bootstrap administrator');
    }
  }

  const app = await buildApp({ ctx });

  const heartbeat = async (state: 'starting' | 'running' | 'draining' | 'stopped') => {
    await ctx.repositories.services.heartbeat(ctx.pool, {
      role: 'api',
      instanceKey,
      version: config.version,
      hostname: hostname(),
      processId: process.pid,
      state,
      leaseSeconds: config.worker.serviceLeaseSeconds,
      metadata: { port: config.api.port, node_env: config.nodeEnv },
    });
  };

  await heartbeat('starting');
  await app.listen({ host: config.api.host, port: config.api.port });
  await heartbeat('running');

  const timer = setInterval(() => {
    heartbeat('running').catch((error: unknown) => {
      ctx.logger.error({ err: error }, 'api heartbeat failed');
    });
  }, config.worker.heartbeatIntervalMs);
  timer.unref();

  ctx.logger.info(
    { host: config.api.host, port: config.api.port, public_url: config.api.publicUrl },
    'Saga API listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.logger.info({ signal }, 'shutting down');
    clearInterval(timer);

    // Hard stop so a wedged in-flight request cannot hold the process open indefinitely.
    const forceExit = setTimeout(() => {
      ctx.logger.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await heartbeat('draining');
      await app.close();
      await ctx.repositories.services.markStopped(ctx.pool, 'api', instanceKey);
    } catch (error) {
      ctx.logger.error({ err: error }, 'error during shutdown');
    } finally {
      await ctx.shutdown();
      clearTimeout(forceExit);
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
