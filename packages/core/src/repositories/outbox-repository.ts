import type { Queryable } from '@saga/database';
import type { NewOutboxEvent, OutboxEvent, OutboxState, OutboxTopic } from '../domain/project.js';

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string | null;
  topic: string;
  payload: Record<string, unknown>;
  state: string;
  attempts: number;
  available_at: Date;
  created_at: Date;
  published_at: Date | null;
  last_error: string | null;
  correlation_id: string | null;
  project_id: string | null;
}

const COLUMNS = `id, aggregate_type, aggregate_id, topic, payload, state, attempts,
                 available_at, created_at, published_at, last_error, correlation_id, project_id`;

function toEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    topic: row.topic as OutboxTopic,
    payload: row.payload,
    state: row.state as OutboxState,
    attempts: row.attempts,
    availableAt: row.available_at,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    lastError: row.last_error,
    correlationId: row.correlation_id,
    projectId: row.project_id,
  };
}

export interface OutboxRepository {
  /** Must be called with the same transaction as the mutation that produced the event. */
  emit(tx: Queryable, event: NewOutboxEvent): Promise<string>;
  emitMany(tx: Queryable, events: readonly NewOutboxEvent[]): Promise<string[]>;
  claimBatch(tx: Queryable, limit: number): Promise<OutboxEvent[]>;
  markPublished(q: Queryable, id: string): Promise<void>;
  markFailed(q: Queryable, id: string, error: string, retryAt: Date | null): Promise<void>;
  counts(q: Queryable): Promise<{ pending: number; failed: number }>;
  deletePublishedBefore(q: Queryable, before: Date): Promise<number>;
}

export class PgOutboxRepository implements OutboxRepository {
  async emit(tx: Queryable, event: NewOutboxEvent): Promise<string> {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO core.outbox_events
         (aggregate_type, aggregate_id, topic, payload, correlation_id, project_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id`,
      [
        event.aggregateType,
        event.aggregateId ?? null,
        event.topic,
        JSON.stringify(event.payload),
        event.correlationId ?? null,
        event.projectId ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  async emitMany(tx: Queryable, events: readonly NewOutboxEvent[]): Promise<string[]> {
    const ids: string[] = [];
    for (const event of events) ids.push(await this.emit(tx, event));
    return ids;
  }

  /**
   * Claim deliverable events. `SKIP LOCKED` lets several worker processes drain the outbox in
   * parallel without blocking each other, and the rows stay locked until the caller's
   * transaction commits.
   */
  async claimBatch(tx: Queryable, limit: number): Promise<OutboxEvent[]> {
    const result = await tx.query<OutboxRow>(
      `WITH claimed AS (
         SELECT id FROM core.outbox_events
          WHERE state IN ('pending', 'processing')
            AND available_at <= now()
          ORDER BY available_at, created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE core.outbox_events e
          SET state = 'processing', attempts = e.attempts + 1
         FROM claimed
        WHERE e.id = claimed.id
       RETURNING ${COLUMNS.split(',')
         .map((column) => `e.${column.trim()}`)
         .join(', ')}`,
      [limit],
    );
    return result.rows.map(toEvent);
  }

  async markPublished(q: Queryable, id: string): Promise<void> {
    await q.query(
      `UPDATE core.outbox_events SET state = 'published', published_at = now(), last_error = NULL
        WHERE id = $1`,
      [id],
    );
  }

  async markFailed(q: Queryable, id: string, error: string, retryAt: Date | null): Promise<void> {
    if (retryAt === null) {
      await q.query(`UPDATE core.outbox_events SET state = 'failed', last_error = $2 WHERE id = $1`, [
        id,
        error,
      ]);
      return;
    }
    await q.query(
      `UPDATE core.outbox_events SET state = 'pending', available_at = $3, last_error = $2
        WHERE id = $1`,
      [id, error, retryAt],
    );
  }

  async counts(q: Queryable): Promise<{ pending: number; failed: number }> {
    const result = await q.query<{ pending: string; failed: string }>(
      `SELECT count(*) FILTER (WHERE state IN ('pending','processing'))::text AS pending,
              count(*) FILTER (WHERE state = 'failed')::text AS failed
         FROM core.outbox_events`,
    );
    const row = result.rows[0]!;
    return { pending: Number(row.pending), failed: Number(row.failed) };
  }

  async deletePublishedBefore(q: Queryable, before: Date): Promise<number> {
    const result = await q.query(
      `DELETE FROM core.outbox_events WHERE state = 'published' AND published_at < $1`,
      [before],
    );
    return result.rowCount ?? 0;
  }
}
