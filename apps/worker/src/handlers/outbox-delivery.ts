import type { OutboxEvent, OutboxRepository, OutboxTopic } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import { errorMessage, nextRetryAt } from '@saga/shared';
import type { JobHandler, SystemEventRepository } from '@saga/shrine';
import { projectOutboxEvent } from './event-projection.js';

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
              await projectOutboxEvent(deps.events, tx, event);
              for (const dispatcher of deps.registry.for(event.topic)) {
                await dispatcher.dispatch(event);
              }
              await deps.outbox.markPublished(tx, event.id);
              delivered += 1;
            } catch (error) {
              failed += 1;
              const retryAt =
                event.attempts >= MAX_OUTBOX_ATTEMPTS
                  ? null
                  : nextRetryAt(new Date(), event.attempts);
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
