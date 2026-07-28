import { PgOutboxRepository, type OutboxTopic } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { PgSystemEventRepository, type ClaimedJob } from '@saga/shrine';
import { createSilentLogger } from '@saga/shared/logging';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, createTestServices, truncateAll } from '../../../../testing/harness.js';
import { createEventProjectionHandler, projectOutboxEvent } from './event-projection.js';

let pool: SagaPool;
let services: ReturnType<typeof createTestServices>;
let projectId: string;

const outbox = new PgOutboxRepository();
const events = new PgSystemEventRepository();

beforeEach(async () => {
  pool ??= createTestPool('saga-event-projection-test');
  services ??= createTestServices({ pool });
  await truncateAll(pool);
  const project = await services.projects.create({ name: `Projection ${crypto.randomUUID()}` });
  projectId = project.id;
});

afterAll(async () => {
  await pool?.end();
});

const handler = () => createEventProjectionHandler({ pool, outbox, events });

function jobFor(payload: Record<string, unknown>): ClaimedJob {
  return {
    id: crypto.randomUUID(),
    projectId: null,
    jobType: 'event_projection',
    entityType: null,
    entityId: null,
    dedupeKey: null,
    state: 'claimed',
    priority: 0,
    payload,
    result: null,
    attempts: 1,
    maxAttempts: 3,
    runAfter: new Date(),
    claimedBy: null,
    claimToken: 'test',
    claimedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    lastError: null,
    correlationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
  };
}

async function run(payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return handler().handle({
    job: jobFor(payload),
    logger: createSilentLogger(),
    signal: new AbortController().signal,
    renewLease: () => Promise.resolve(true),
  });
}

/** Emit a durable event and mark it published, i.e. delivered but not yet projected. */
async function emitPublished(
  topic: OutboxTopic,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = await outbox.emit(pool, {
    aggregateType: 'project',
    aggregateId: projectId,
    topic,
    payload,
    projectId,
  });
  await outbox.markPublished(pool, id);
  return id;
}

async function projectionCount(outboxEventId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM shrine.system_events
      WHERE metadata ->> 'outbox_event_id' = $1`,
    [outboxEventId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('projection idempotency', () => {
  it('records a projection the first time and nothing the second', async () => {
    const id = await emitPublished('lore.memory_published', {
      memory_revision: 1,
      entry_count: 2,
    });
    const event = (await outbox.listUnprojected(pool, new Date(Date.now() - 60_000), 10))[0]!;

    await expect(projectOutboxEvent(events, pool, event)).resolves.toBe(true);
    await expect(projectOutboxEvent(events, pool, event)).resolves.toBe(false);
    expect(await projectionCount(id)).toBe(1);
  });

  it('renders the topic into a human-readable message', async () => {
    await emitPublished('quest.checkpoint_created', { title: 'Add CSV export', kind: 'milestone' });
    const event = (await outbox.listUnprojected(pool, new Date(Date.now() - 60_000), 10))[0]!;
    await projectOutboxEvent(events, pool, event);

    const recorded = await events.list(pool, { projectId, limit: 10 });
    expect(recorded[0]?.message).toBe('Checkpoint recorded for "Add CSV export" (milestone).');
    expect(recorded[0]?.eventType).toBe('quest.checkpoint_created');
  });

  it('keeps the correlation id on the projected event', async () => {
    const id = await outbox.emit(pool, {
      aggregateType: 'project',
      aggregateId: projectId,
      topic: 'core.project_created',
      payload: { name: 'Anything' },
      projectId,
      correlationId: 'req-abc',
    });
    await outbox.markPublished(pool, id);

    await run();
    const recorded = await events.list(pool, { projectId, limit: 10 });
    expect(recorded[0]?.metadata.correlation_id).toBe('req-abc');
    expect(recorded[0]?.metadata.outbox_event_id).toBe(id);
  });
});

describe('the event_projection job', () => {
  it('back-fills a published event that was never projected', async () => {
    const id = await emitPublished('party.claim_acquired', {
      resource_type: 'migration_sequence',
      resource_key: 'db/migrations',
      mode: 'exclusive',
    });

    await expect(run()).resolves.toEqual({ scanned: 1, projected: 1 });
    expect(await projectionCount(id)).toBe(1);
  });

  it('is a no-op on a second run — the repair cannot duplicate the feed', async () => {
    const id = await emitPublished('quest.session_started', { client: 'codex' });
    await run();

    await expect(run()).resolves.toEqual({ scanned: 0, projected: 0 });
    expect(await projectionCount(id)).toBe(1);
  });

  it('ignores events that are still pending delivery', async () => {
    await outbox.emit(pool, {
      aggregateType: 'project',
      aggregateId: projectId,
      topic: 'quest.session_started',
      payload: { client: 'codex' },
      projectId,
    });

    await expect(run()).resolves.toEqual({ scanned: 0, projected: 0 });
  });

  it('does not reach past its window', async () => {
    const id = await emitPublished('quest.session_ended', { client: 'codex' });
    await pool.query(`UPDATE core.outbox_events SET published_at = now() - interval '3 days'`);

    await expect(run({ window_hours: 24 })).resolves.toEqual({ scanned: 0, projected: 0 });
    await expect(run({ window_hours: 24 * 7 })).resolves.toEqual({ scanned: 1, projected: 1 });
    expect(await projectionCount(id)).toBe(1);
  });

  it('honours the batch limit so a large gap is repaired incrementally', async () => {
    for (let i = 0; i < 5; i += 1) {
      await emitPublished('quest.session_started', { client: `agent-${String(i)}` });
    }

    await expect(run({ limit: 2 })).resolves.toEqual({ scanned: 2, projected: 2 });
    await expect(run({ limit: 2 })).resolves.toEqual({ scanned: 2, projected: 2 });
    await expect(run({ limit: 2 })).resolves.toEqual({ scanned: 1, projected: 1 });
    await expect(run({ limit: 2 })).resolves.toEqual({ scanned: 0, projected: 0 });
  });

  it('rejects an out-of-range payload rather than scanning the whole table', async () => {
    await expect(run({ window_hours: 0 })).rejects.toThrow();
    await expect(run({ limit: 10_000 })).rejects.toThrow();
  });
});
