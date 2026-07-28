import type { OutboxEvent, OutboxRepository } from '@saga/core';
import type { Queryable, SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import type { JobHandler, SystemEventRepository, SystemEventSeverity } from '@saga/shrine';
import { z } from 'zod';

const DEFAULT_WINDOW_HOURS = 24;
const MAX_BATCH = 500;

const payloadSchema = z.object({
  /** How far back to look for gaps. Bounded so a repair run can never scan the whole table. */
  window_hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  limit: z.number().int().min(1).max(MAX_BATCH).optional(),
});

/**
 * Project one durable domain event onto the human-readable Shrine feed that SSE replays.
 *
 * Returns false when the event was already projected. Delivery is at-least-once (ADR-0004),
 * so this is called more than once for the same event after a crash; the unique index from
 * migration 0005 is what makes the second call a no-op rather than a duplicate feed entry.
 */
export async function projectOutboxEvent(
  events: SystemEventRepository,
  q: Queryable,
  event: OutboxEvent,
): Promise<boolean> {
  const { severity, message } = describeEvent(event);
  const recorded = await events.recordProjection(q, {
    severity,
    category: event.topic.split('.')[0] ?? 'core',
    projectId: event.projectId,
    entityType: event.aggregateType,
    entityId: event.aggregateId,
    eventType: event.topic,
    message,
    metadata: { ...event.payload, outbox_event_id: event.id, correlation_id: event.correlationId },
  });
  return recorded !== null;
}

export interface EventProjectionDeps {
  pool: SagaPool;
  outbox: OutboxRepository;
  events: SystemEventRepository;
}

/**
 * Repairs the Shrine feed.
 *
 * Delivery normally projects an event inline, so this job finds nothing. It exists for the
 * cases where that inline projection did not survive: a dispatcher that threw after the
 * projection insert was rolled back, a feed truncated by an operator, or a build that was
 * upgraded while events were in flight. Because projection is keyed on the outbox event id,
 * re-running this is always safe.
 */
export function createEventProjectionHandler(deps: EventProjectionDeps): JobHandler {
  return {
    type: 'event_projection',
    describe: {
      input: '{ window_hours?: number, limit?: number } — defaults to the last 24 hours.',
      idempotency:
        'Keyed on metadata.outbox_event_id (unique index). Re-running projects nothing that already exists.',
      retryPolicy: 'Retryable: a database interruption leaves the remaining gap for the next run.',
      sideEffects: 'Inserts missing shrine.system_events rows. Never modifies outbox state.',
      result: '{ scanned: number, projected: number }',
      failureCodes: ['EVENT_PROJECTION_INVALID_PAYLOAD'],
    },

    async handle({ job, signal }) {
      const payload = payloadSchema.parse(job.payload);
      const windowHours = payload.window_hours ?? DEFAULT_WINDOW_HOURS;
      const limit = payload.limit ?? MAX_BATCH;
      const since = new Date(Date.now() - windowHours * 3_600_000);

      return withTransaction(deps.pool, async (tx) => {
        const pending = await deps.outbox.listUnprojected(tx, since, limit);
        let projected = 0;
        for (const event of pending) {
          if (signal.aborted) break;
          if (await projectOutboxEvent(deps.events, tx, event)) projected += 1;
        }
        return { scanned: pending.length, projected };
      });
    },
  };
}

export function describeEvent(event: OutboxEvent): {
  severity: SystemEventSeverity;
  message: string;
} {
  const payload = event.payload as Record<string, unknown>;
  const name = typeof payload.name === 'string' ? payload.name : null;
  const title = typeof payload.title === 'string' ? payload.title : null;

  switch (event.topic) {
    case 'core.project_created':
      return { severity: 'info', message: `Project "${name ?? 'unknown'}" was created.` };
    case 'core.project_renamed':
      return {
        severity: 'info',
        message: `Project was renamed from "${String(payload.from)}" to "${String(payload.to)}".`,
      };
    case 'core.project_archived':
      return { severity: 'warning', message: `Project "${name ?? 'unknown'}" was archived.` };
    case 'core.project_restored':
      return { severity: 'info', message: `Project "${name ?? 'unknown'}" was restored.` };
    case 'lore.memory_published':
      return {
        severity: 'info',
        message: `Lore revision ${String(payload.memory_revision)} was published (${String(payload.entry_count)} entr${payload.entry_count === 1 ? 'y' : 'ies'}).`,
      };
    case 'lore.memory_marked_stale':
      return {
        severity: 'warning',
        message: `Lore entry "${String(payload.memory_key)}" was marked stale.`,
      };
    case 'lore.memory_archived':
      return {
        severity: 'info',
        message: `Lore entry "${String(payload.memory_key)}" was archived.`,
      };
    case 'quest.checkpoint_created':
      return {
        severity: 'info',
        message: `Checkpoint recorded for "${title ?? 'a Quest'}" (${String(payload.kind)}).`,
      };
    case 'quest.status_changed':
      return {
        severity: 'info',
        message: `Quest "${title ?? 'unknown'}" moved from ${String(payload.from)} to ${String(payload.to)}.`,
      };
    case 'quest.completed':
      return { severity: 'info', message: `Quest "${title ?? 'unknown'}" was completed.` };
    case 'quest.session_started':
      return { severity: 'info', message: `A ${String(payload.client)} session started.` };
    case 'quest.session_ended':
      return { severity: 'info', message: `A ${String(payload.client)} session ended.` };
    case 'quest.session_abandoned':
      return { severity: 'warning', message: `A session was abandoned without a clean end.` };
    case 'party.agent_started':
      return { severity: 'info', message: `Agent run started for ${String(payload.client)}.` };
    case 'party.agent_expired':
      return {
        severity: 'warning',
        message: `An agent run lease expired; its claims were released.`,
      };
    case 'party.agent_ended':
      return { severity: 'info', message: `An agent run ended cleanly.` };
    case 'party.claim_acquired':
      return {
        severity: 'info',
        message: `Claim acquired on ${String(payload.resource_type)} "${String(payload.resource_key)}" (${String(payload.mode)}).`,
      };
    case 'party.claim_released':
      return {
        severity: 'info',
        message: `Claim released on ${String(payload.resource_type)} "${String(payload.resource_key)}".`,
      };
    case 'party.claim_revoked':
      return {
        severity: 'warning',
        message: `Claim on ${String(payload.resource_type)} "${String(payload.resource_key)}" was revoked by an administrator.`,
      };
    case 'shrine.job_failed':
      return { severity: 'error', message: `Job ${String(payload.job_type)} failed.` };
    default:
      return { severity: 'info', message: `${event.topic}` };
  }
}
