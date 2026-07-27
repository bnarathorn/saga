import { errorMessage } from '@saga/shared';
import type { WorkerContext } from './context.js';
import { createCleanupHandler } from './handlers/cleanup.js';
import { noopHandler } from './handlers/noop.js';
import { createOutboxDeliveryHandler } from './handlers/outbox-delivery.js';
import {
  createContextSnapshotHandler,
  createEmbeddingHandler,
  createMemoryValidationHandler,
  createStaleDetectionHandler,
} from './handlers/lore.js';

const CLEANUP_INTERVAL_MS = 60 * 60_000;

/** Register every job handler this build knows how to run. */
export function registerHandlers(ctx: WorkerContext): void {
  ctx.handlers.register(noopHandler);
  ctx.handlers.register(
    createOutboxDeliveryHandler({
      pool: ctx.pool,
      outbox: ctx.repositories.outbox,
      events: ctx.repositories.events,
      registry: ctx.dispatchers,
    }),
  );
  ctx.handlers.register(
    createEmbeddingHandler({
      pool: ctx.pool,
      memory: ctx.repositories.memory,
      provider: ctx.embeddings,
    }),
  );
  ctx.handlers.register(
    createMemoryValidationHandler({
      pool: ctx.pool,
      lore: ctx.services.lore,
      memory: ctx.repositories.memory,
      projects: ctx.repositories.projects,
    }),
  );
  ctx.handlers.register(
    createContextSnapshotHandler({
      pool: ctx.pool,
      lore: ctx.services.lore,
      projects: ctx.repositories.projects,
      memory: ctx.repositories.memory,
      snapshots: ctx.repositories.snapshots,
      coreContextTokens: ctx.config.context.coreTokens,
    }),
  );
  ctx.handlers.register(
    createStaleDetectionHandler({
      pool: ctx.pool,
      lore: ctx.services.lore,
      memory: ctx.repositories.memory,
      projects: ctx.repositories.projects,
    }),
  );
  ctx.handlers.register(
    createCleanupHandler({
      pool: ctx.pool,
      jobs: ctx.repositories.jobs,
      events: ctx.repositories.events,
      outbox: ctx.repositories.outbox,
      idempotency: ctx.repositories.idempotency,
      services: ctx.repositories.services,
      retention: {
        jobDays: ctx.config.retention.jobDays,
        systemEventDays: ctx.config.retention.systemEventDays,
        idempotencyHours: ctx.config.retention.idempotencyHours,
      },
    }),
  );
}

/**
 * Periodic work that is infrastructure rather than domain work.
 *
 * Outbox delivery runs *inline* on a timer instead of being enqueued as a job every second:
 * enqueuing would add a queue row per tick and bury real work under bookkeeping. The
 * `outbox_delivery` handler stays registered so an operator can still trigger a drain by hand
 * from Shrine.
 */
export function startMaintenance(ctx: WorkerContext): () => void {
  const outboxHandler = ctx.handlers.get('outbox_delivery');
  const abort = new AbortController();
  let draining = false;

  const drainOutbox = async (): Promise<void> => {
    if (draining || outboxHandler === undefined) return;
    draining = true;
    try {
      await outboxHandler.handle({
        job: {
          id: 'inline-outbox',
          projectId: null,
          jobType: 'outbox_delivery',
          entityType: null,
          entityId: null,
          dedupeKey: null,
          state: 'claimed',
          priority: 0,
          payload: {},
          result: null,
          attempts: 1,
          maxAttempts: 1,
          runAfter: new Date(),
          claimedBy: null,
          claimToken: 'inline',
          claimedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
          lastError: null,
          correlationId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
        },
        logger: ctx.logger,
        signal: abort.signal,
        renewLease: async () => true,
      });
    } catch (error) {
      ctx.logger.error({ err: error, reason: errorMessage(error) }, 'inline outbox drain failed');
    } finally {
      draining = false;
    }
  };

  const outboxTimer = setInterval(() => void drainOutbox(), Math.max(500, ctx.config.worker.pollIntervalMs));
  outboxTimer.unref();

  const enqueueCleanup = async (): Promise<void> => {
    try {
      // The dedupe key means a second scheduler process cannot double-enqueue.
      await ctx.services.jobs.enqueue({
        jobType: 'cleanup',
        payload: {},
        dedupeKey: 'periodic',
        priority: -10,
        maxAttempts: 3,
      });
    } catch (error) {
      ctx.logger.error({ err: error }, 'could not enqueue the cleanup job');
    }
  };

  void enqueueCleanup();
  const cleanupTimer = setInterval(() => void enqueueCleanup(), CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  return () => {
    abort.abort();
    clearInterval(outboxTimer);
    clearInterval(cleanupTimer);
  };
}
