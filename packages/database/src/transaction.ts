import type { PoolClient } from 'pg';
import type { SagaPool } from './pool.js';
import type { Queryable, TransactionClient } from './types.js';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
}

function asTransactionClient(client: PoolClient): TransactionClient {
  return {
    inTransaction: true,
    query: (text, values) => client.query(text, values as unknown[] | undefined),
  } as TransactionClient;
}

/**
 * The only place Saga issues BEGIN/COMMIT/ROLLBACK. Services open transactions; repositories
 * and route handlers never do.
 *
 * A failure inside `fn` always rolls back and rethrows — Saga never swallows a transaction
 * error, because a half-applied domain mutation is worse than a visible 500.
 */
export async function withTransaction<T>(
  pool: SagaPool,
  fn: (tx: TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  const level = options.isolationLevel ?? 'read committed';
  const access = options.readOnly === true ? ' READ ONLY' : '';

  try {
    await client.query(`BEGIN ISOLATION LEVEL ${level.toUpperCase()}${access}`);
    const result = await fn(asTransactionClient(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Surface rollback failures rather than hiding them behind the original error:
      // a failed rollback means the connection is unusable and must not be reused.
      client.release(rollbackError as Error);
      throw error;
    }
    throw error;
  } finally {
    // `release()` is a no-op if the client was already released with an error above.
    client.release();
  }
}

/** Hash an arbitrary string into the 64-bit key space `pg_advisory_lock` expects. */
export function advisoryLockKey(namespace: string): [number, number] {
  let hi = 0x811c9dc5;
  let lo = 0x01000193;
  for (let i = 0; i < namespace.length; i += 1) {
    const code = namespace.charCodeAt(i);
    hi = Math.imul(hi ^ code, 16777619) | 0;
    lo = Math.imul(lo + code, 2654435761) | 0;
  }
  return [hi, lo];
}

/** Take a transaction-scoped advisory lock; released automatically at COMMIT or ROLLBACK. */
export async function acquireAdvisoryLock(tx: Queryable, namespace: string): Promise<void> {
  const [hi, lo] = advisoryLockKey(namespace);
  await tx.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [hi, lo]);
}

/** Session-scoped advisory lock for processes (such as the migration runner) that manage
 * their own transaction boundaries. The caller must release it. */
export async function acquireSessionAdvisoryLock(
  client: Queryable,
  namespace: string,
): Promise<() => Promise<void>> {
  const [hi, lo] = advisoryLockKey(namespace);
  await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [hi, lo]);
  return async () => {
    await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [hi, lo]);
  };
}
