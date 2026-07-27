import type { OutboxEvent, OutboxRepository, OutboxTopic } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import { errorMessage, nextRetryAt } from '@saga/shared';
import type { JobHandler, SystemEventRepository } from '@saga/shrine';

const MAX_OUTBOX_ATTEMPTS = 8;
const BATCH_SIZE = 50;

/**
 * A dispatcher reacts to one topic. Dispatchers must be idempotent: outbox delivery is
 * at-least-once (ADR-0004).
 */
export interface OutboxDispatcher {
  readonly topics: readonly OutboxTopic[];
  dispatch(event: OutboxEvent): Promise<void>;
}

export class OutboxDispatcherRegistry {
  private readonly byTopic = new Map<OutboxTopic, OutboxDispatcher[]>();

  register(dispatcher: OutboxDispatcher): void {
    for (const topic of dispatcher.topics) {
      const list = this.byTopic.get(topic) ?? [];
      list.push(dispatcher);
      this.byTopic.set(topic, list);
    }
  }

  for(topic: OutboxTopic): OutboxDispatcher[] {
    return this.byTopic.get(topic) ?? [];
  }
}

export interface OutboxDeliveryDeps {
  pool: SagaPool;
  outbox: OutboxRepository;
  events: SystemEventRepository;
  registry: OutboxDispatcherRegistry;
}

/**
 * Drains `core.outbox_events`. Rows are claimed with `FOR UPDATE SKIP LOCKED` inside a
 * transaction, dispatched, then marked published — so a crash mid-dispatch redelivers rather
 * than dropping the event.
 */
export function createOutboxDeliveryHandler(deps: OutboxDeliveryDeps): JobHandler {
  return {
    type: 'outbox_delivery',
    describe: {
      input: '{}  — the handler drains whatever is pending.',
      idempotency:
        'At-least-once. Each dispatcher must tolerate seeing the same event twice; the projection into shrine.system_events is keyed on the event id.',
      retryPolicy:
        'Per-event: exponential backoff up to 8 attempts, then the event is marked failed and surfaced in Shrine.',
      sideEffects: 'Writes shrine.system_events and invokes registered dispatchers.',
      result: '{ delivered: number, failed: number, remaining_hint: number }',
      failureCodes: ['OUTBOX_DISPATCH_FAILED'],
    },

    async handle({ signal }) {
      let delivered = 0;
      let failed = 0;
      let batch: OutboxEvent[] = [];

      do {
        if (signal.aborted) break;

        batch = await withTransaction(deps.pool, async (tx) => {
          const claimed = await deps.outbox.claimBatch(tx, BATCH_SIZE);

          for (const event of claimed) {
            try {
              await projectToSystemEvent(deps, tx, event);
              for (const dispatcher of deps.registry.for(event.topic)) {
                await dispatcher.dispatch(event);
              }
              await deps.outbox.markPublished(tx, event.id);
              delivered += 1;
            } catch (error) {
              failed += 1;
              const retryAt =
                event.attempts >= MAX_OUTBOX_ATTEMPTS ? null : nextRetryAt(new Date(), event.attempts);
              await deps.outbox.markFailed(
                tx,
                event.id,
                `OUTBOX_DISPATCH_FAILED: ${errorMessage(error)}`,
                retryAt,
              );
            }
          }

          return claimed;
        });
      } while (batch.length === BATCH_SIZE);

      return { delivered, failed, remaining_hint: batch.length };
    },
  };
}

/** Map a durable domain event onto the human-readable Shrine feed that SSE replays. */
async function projectToSystemEvent(
  deps: OutboxDeliveryDeps,
  tx: Parameters<SystemEventRepository['record']>[0],
  event: OutboxEvent,
): Promise<void> {
  const { severity, message } = describeEvent(event);
  await deps.events.record(tx, {
    severity,
    category: event.topic.split('.')[0] ?? 'core',
    projectId: event.projectId,
    entityType: event.aggregateType,
    entityId: event.aggregateId,
    eventType: event.topic,
    message,
    metadata: { ...event.payload, outbox_event_id: event.id, correlation_id: event.correlationId },
  });
}

function describeEvent(event: OutboxEvent): {
  severity: 'info' | 'warning' | 'error' | 'critical';
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
      return { severity: 'warning', message: `Lore entry "${String(payload.memory_key)}" was marked stale.` };
    case 'lore.memory_archived':
      return { severity: 'info', message: `Lore entry "${String(payload.memory_key)}" was archived.` };
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
