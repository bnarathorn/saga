import { SagaError } from '@saga/shared';

/** PostgreSQL error codes Saga reacts to by name rather than by message. */
export const PG_ERROR = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
  undefinedTable: '42P01',
  undefinedObject: '42704',
} as const;

interface PgErrorShape {
  code?: string;
  constraint?: string;
  detail?: string;
}

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as PgErrorShape).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    const constraint = (error as PgErrorShape).constraint;
    return typeof constraint === 'string' ? constraint : undefined;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (pgErrorCode(error) !== PG_ERROR.uniqueViolation) return false;
  return constraint === undefined || pgConstraint(error) === constraint;
}

export function isRetryablePgError(error: unknown): boolean {
  const code = pgErrorCode(error);
  return (
    code === PG_ERROR.serializationFailure ||
    code === PG_ERROR.deadlockDetected ||
    code === PG_ERROR.lockNotAvailable
  );
}

/**
 * pgvector has no binary codec in `pg`, so vectors cross the wire as the `'[a,b,c]'` text
 * literal and are cast with `::vector` in the statement.
 */
export function toVectorLiteral(values: readonly number[]): string {
  if (values.length === 0) {
    throw new SagaError('INTERNAL_ERROR', 'Refusing to serialise an empty vector.');
  }
  const parts = values.map((value) => {
    if (!Number.isFinite(value)) {
      throw new SagaError('INTERNAL_ERROR', 'Vector contains a non-finite component.');
    }
    return value.toFixed(6);
  });
  return `[${parts.join(',')}]`;
}

export function parseVectorLiteral(literal: string | null): number[] | null {
  if (literal === null) return null;
  const trimmed = literal.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1);
  if (inner.length === 0) return [];
  return inner.split(',').map((part) => Number.parseFloat(part));
}

/**
 * Build `$1, $2, ...` placeholder groups for a multi-row INSERT.
 * Returns the fragment plus the flattened value list.
 */
export function buildValuesClause(
  rows: readonly (readonly unknown[])[],
  casts?: readonly (string | null)[],
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const groups: string[] = [];
  let index = 1;
  for (const row of rows) {
    const placeholders = row.map((value, column) => {
      values.push(value);
      const cast = casts?.[column];
      const placeholder = `$${index}`;
      index += 1;
      return cast == null ? placeholder : `${placeholder}::${cast}`;
    });
    groups.push(`(${placeholders.join(', ')})`);
  }
  return { text: groups.join(', '), values };
}

/** Deterministic lock ordering: multi-row `FOR UPDATE` always sorts ids ascending. */
export function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}
