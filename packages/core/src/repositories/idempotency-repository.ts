import type { Queryable } from '@saga/database';
import { isUniqueViolation } from '@saga/database';

export interface IdempotencyRecord {
  id: string;
  actorKey: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  state: 'in_progress' | 'completed';
  responseStatus: number | null;
  responseBody: unknown;
  resourceId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

interface Row {
  id: string;
  actor_key: string;
  operation: string;
  idempotency_key: string;
  request_hash: string;
  state: string;
  response_status: number | null;
  response_body: unknown;
  resource_id: string | null;
  created_at: Date;
  expires_at: Date;
}

const COLUMNS = `id, actor_key, operation, idempotency_key, request_hash, state,
                 response_status, response_body, resource_id, created_at, expires_at`;

function toRecord(row: Row): IdempotencyRecord {
  return {
    id: row.id,
    actorKey: row.actor_key,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    state: row.state as 'in_progress' | 'completed',
    responseStatus: row.response_status,
    responseBody: row.response_body,
    resourceId: row.resource_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export interface ReserveResult {
  /** True when this caller won the reservation and must perform the operation. */
  reserved: boolean;
  existing: IdempotencyRecord | null;
}

export interface IdempotencyRepository {
  reserve(
    q: Queryable,
    input: {
      actorKey: string;
      operation: string;
      idempotencyKey: string;
      requestHash: string;
      expiresAt: Date;
    },
  ): Promise<ReserveResult>;
  complete(
    q: Queryable,
    id: string,
    responseStatus: number,
    responseBody: unknown,
    resourceId: string | null,
  ): Promise<void>;
  release(q: Queryable, id: string): Promise<void>;
  deleteExpired(q: Queryable, before: Date): Promise<number>;
}

export class PgIdempotencyRepository implements IdempotencyRepository {
  /**
   * Atomically claim `(actor, operation, key)`. A losing caller receives the existing record so
   * the route layer can replay a stored response or reject a body mismatch.
   *
   * Expired records are reclaimed in the same statement, so a crashed request cannot wedge a
   * key forever.
   */
  async reserve(
    q: Queryable,
    input: {
      actorKey: string;
      operation: string;
      idempotencyKey: string;
      requestHash: string;
      expiresAt: Date;
    },
  ): Promise<ReserveResult> {
    try {
      const inserted = await q.query<Row>(
        `INSERT INTO core.idempotency_records
           (actor_key, operation, idempotency_key, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (actor_key, operation, idempotency_key) DO UPDATE
           SET request_hash = EXCLUDED.request_hash,
               state = 'in_progress',
               response_status = NULL,
               response_body = NULL,
               resource_id = NULL,
               created_at = now(),
               completed_at = NULL,
               expires_at = EXCLUDED.expires_at
           WHERE core.idempotency_records.expires_at < now()
         RETURNING ${COLUMNS}`,
        [input.actorKey, input.operation, input.idempotencyKey, input.requestHash, input.expiresAt],
      );

      if (inserted.rows[0] !== undefined) {
        return { reserved: true, existing: toRecord(inserted.rows[0]) };
      }

      // The ON CONFLICT WHERE clause suppressed the update: a live record already exists.
      const existing = await q.query<Row>(
        `SELECT ${COLUMNS} FROM core.idempotency_records
          WHERE actor_key = $1 AND operation = $2 AND idempotency_key = $3`,
        [input.actorKey, input.operation, input.idempotencyKey],
      );
      return {
        reserved: false,
        existing: existing.rows[0] === undefined ? null : toRecord(existing.rows[0]),
      };
    } catch (error) {
      if (isUniqueViolation(error, 'idempotency_lookup_uniq')) {
        const existing = await q.query<Row>(
          `SELECT ${COLUMNS} FROM core.idempotency_records
            WHERE actor_key = $1 AND operation = $2 AND idempotency_key = $3`,
          [input.actorKey, input.operation, input.idempotencyKey],
        );
        return {
          reserved: false,
          existing: existing.rows[0] === undefined ? null : toRecord(existing.rows[0]),
        };
      }
      throw error;
    }
  }

  async complete(
    q: Queryable,
    id: string,
    responseStatus: number,
    responseBody: unknown,
    resourceId: string | null,
  ): Promise<void> {
    await q.query(
      `UPDATE core.idempotency_records
          SET state = 'completed', response_status = $2, response_body = $3::jsonb,
              resource_id = $4, completed_at = now()
        WHERE id = $1`,
      [id, responseStatus, JSON.stringify(responseBody ?? null), resourceId],
    );
  }

  /** Drop a reservation whose operation failed, so the caller may retry with the same key. */
  async release(q: Queryable, id: string): Promise<void> {
    await q.query(`DELETE FROM core.idempotency_records WHERE id = $1 AND state = 'in_progress'`, [
      id,
    ]);
  }

  async deleteExpired(q: Queryable, before: Date): Promise<number> {
    const result = await q.query(`DELETE FROM core.idempotency_records WHERE expires_at < $1`, [
      before,
    ]);
    return result.rowCount ?? 0;
  }
}
