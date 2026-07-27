import pg from 'pg';
import { SagaError } from '@saga/shared';
import { sanitizeConnectionString } from '@saga/shared';

const { Pool, types } = pg;

export type SagaPool = pg.Pool;

let typesConfigured = false;

/**
 * `pg` returns `bigint` (OID 20) and `numeric` (OID 1700) as strings to avoid precision loss.
 * Saga's bigints are revision counters and sequence numbers that comfortably fit in a JS
 * number, and its numerics are confidence values in [0,1]; parsing them here keeps that
 * conversion in exactly one place instead of scattered `Number(row.x)` calls.
 */
function configureTypeParsers(): void {
  if (typesConfigured) return;
  types.setTypeParser(20, (value) => Number.parseInt(value, 10));
  types.setTypeParser(1700, (value) => Number.parseFloat(value));
  typesConfigured = true;
}

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  /** Called for pool-level errors on idle clients; must never be silent. */
  onError?: (error: Error) => void;
}

export function createPool(options: CreatePoolOptions): SagaPool {
  configureTypeParsers();

  if (options.connectionString.trim().length === 0) {
    throw new SagaError('INTERNAL_ERROR', 'DATABASE_URL is empty.');
  }

  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'saga',
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 30_000,
    allowExitOnIdle: false,
  });

  pool.on('error', (error) => {
    if (options.onError) options.onError(error);
    else
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'idle postgres client error',
          error: error.message,
          database: sanitizeConnectionString(options.connectionString),
        }),
      );
  });

  return pool;
}

export async function closePool(pool: SagaPool): Promise<void> {
  await pool.end();
}
