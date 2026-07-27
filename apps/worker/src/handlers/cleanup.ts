import {
  DeviceCodeRepository,
  WebSessionRepository,
  type IdempotencyRepository,
  type OutboxRepository,
} from '@saga/core';
import type { SagaPool } from '@saga/database';
import { addSeconds } from '@saga/shared';
import type { JobHandler, JobRepository, ServiceInstanceRepository, SystemEventRepository } from '@saga/shrine';

export interface CleanupDeps {
  pool: SagaPool;
  jobs: JobRepository;
  events: SystemEventRepository;
  outbox: OutboxRepository;
  idempotency: IdempotencyRepository;
  services: ServiceInstanceRepository;
  retention: { jobDays: number; systemEventDays: number; idempotencyHours: number };
}

/**
 * Retention. Everything removed here is operational exhaust — finished jobs, delivered outbox
 * rows, expired sessions. Durable Lore and Quest history is archived, never deleted.
 */
export function createCleanupHandler(deps: CleanupDeps): JobHandler {
  const sessions = new WebSessionRepository();
  const deviceCodes = new DeviceCodeRepository();

  return {
    type: 'cleanup',
    describe: {
      input: '{}',
      idempotency: 'Deleting already-deleted rows is a no-op, so re-running is always safe.',
      retryPolicy: 'Standard backoff; a failure only delays reclaiming disk.',
      sideEffects:
        'Deletes finished jobs, published outbox rows, old system events, expired web sessions, expired device codes, expired idempotency records and dead service instances.',
      result: 'Counts of rows removed per table.',
      failureCodes: [],
    },

    async handle() {
      const now = new Date();
      const jobCutoff = addSeconds(now, -deps.retention.jobDays * 86_400);
      const eventCutoff = addSeconds(now, -deps.retention.systemEventDays * 86_400);
      const idempotencyCutoff = addSeconds(now, -deps.retention.idempotencyHours * 3_600);
      // A service instance whose lease died a day ago is gone, not merely restarting.
      const serviceCutoff = addSeconds(now, -86_400);

      await deviceCodes.expireStale(deps.pool);

      const [
        removedJobs,
        removedOutbox,
        removedEvents,
        removedSessions,
        removedDeviceCodes,
        removedIdempotency,
        removedServices,
      ] = await Promise.all([
        deps.jobs.deleteFinishedBefore(deps.pool, jobCutoff),
        deps.outbox.deletePublishedBefore(deps.pool, eventCutoff),
        deps.events.deleteBefore(deps.pool, eventCutoff),
        sessions.deleteExpiredBefore(deps.pool, now),
        deviceCodes.deleteBefore(deps.pool, addSeconds(now, -86_400)),
        deps.idempotency.deleteExpired(deps.pool, idempotencyCutoff),
        deps.services.deleteStaleBefore(deps.pool, serviceCutoff),
      ]);

      return {
        jobs: removedJobs,
        outbox_events: removedOutbox,
        system_events: removedEvents,
        web_sessions: removedSessions,
        device_codes: removedDeviceCodes,
        idempotency_records: removedIdempotency,
        service_instances: removedServices,
      };
    },
  };
}
