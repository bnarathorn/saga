import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Anything a repository can run SQL against: the pool, or a client inside an open
 * transaction. Repositories always receive a `Queryable` so that a service decides the
 * transaction boundary, never the repository.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export type { QueryResult, QueryResultRow };

/** A `Queryable` known to be inside a transaction. Used to make intent explicit in signatures. */
export interface TransactionClient extends Queryable {
  readonly inTransaction: true;
}
