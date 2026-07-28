import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SagaError } from '@saga/shared';
import type { SagaPool } from './pool.js';
import { acquireSessionAdvisoryLock } from './transaction.js';

export const MIGRATION_LOCK_NAMESPACE = 'saga:schema_migrations';

/** A migration whose first line contains this directive runs outside a transaction. */
const NO_TRANSACTION_DIRECTIVE = '-- saga:no-transaction';

const FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
}

export interface MigrationStatus {
  currentVersion: number;
  expectedVersion: number;
  applied: AppliedMigration[];
  pending: MigrationFile[];
  /** True when every migration on disk has been applied with a matching checksum. */
  upToDate: boolean;
}

function checksumOf(sql: string): string {
  // Normalise line endings so a checkout on another platform does not invalidate history.
  return `sha256:${createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')}`;
}

export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const files: MigrationFile[] = [];

  for (const filename of entries.sort()) {
    if (!filename.endsWith('.sql')) continue;
    const match = FILENAME_RE.exec(filename);
    if (match === null) {
      throw new SagaError(
        'INTERNAL_ERROR',
        `Migration filename "${filename}" must look like 0001_snake_case_name.sql`,
      );
    }
    const sql = await readFile(join(directory, filename), 'utf8');
    files.push({
      version: Number.parseInt(match[1]!, 10),
      name: match[2]!,
      filename,
      sql,
      checksum: checksumOf(sql),
      transactional: !sql.slice(0, 200).includes(NO_TRANSACTION_DIRECTIVE),
    });
  }

  files.sort((a, b) => a.version - b.version);

  for (const [index, file] of files.entries()) {
    if (file.version !== index + 1) {
      throw new SagaError(
        'INTERNAL_ERROR',
        `Migration versions must be a gapless sequence starting at 1; found ${file.version} at position ${index + 1}.`,
      );
    }
  }

  return files;
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version    integer PRIMARY KEY,
  name       text NOT NULL,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

async function ensureLedger(pool: SagaPool): Promise<void> {
  await pool.query(LEDGER_DDL);
}

export async function readApplied(pool: SagaPool): Promise<AppliedMigration[]> {
  await ensureLedger(pool);
  const result = await pool.query<AppliedMigration>(
    'SELECT version, name, checksum, applied_at FROM public.schema_migrations ORDER BY version',
  );
  return result.rows;
}

/**
 * Compare disk against the ledger. Throws on any checksum mismatch: an already-applied
 * migration must never be rewritten, because the database cannot be re-derived from it.
 */
export function diffMigrations(
  onDisk: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): { pending: MigrationFile[]; currentVersion: number } {
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));

  for (const record of applied) {
    const file = onDisk.find((candidate) => candidate.version === record.version);
    if (file === undefined) {
      throw new SagaError(
        'SCHEMA_VERSION_MISMATCH',
        `Migration ${record.version} (${record.name}) is recorded as applied but is missing from disk.`,
        { details: { version: record.version, name: record.name } },
      );
    }
    if (file.checksum !== record.checksum) {
      throw new SagaError(
        'SCHEMA_VERSION_MISMATCH',
        `Migration ${record.version} (${record.name}) was modified after it was applied. Applied migrations are immutable; add a new forward migration instead.`,
        {
          details: {
            version: record.version,
            name: record.name,
            applied_checksum: record.checksum,
            disk_checksum: file.checksum,
          },
        },
      );
    }
  }

  const pending = onDisk.filter((file) => !appliedByVersion.has(file.version));
  const currentVersion = applied.reduce((max, row) => Math.max(max, row.version), 0);
  return { pending, currentVersion };
}

export async function migrationStatus(pool: SagaPool, directory: string): Promise<MigrationStatus> {
  const onDisk = await loadMigrations(directory);
  const applied = await readApplied(pool);
  const { pending, currentVersion } = diffMigrations(onDisk, applied);
  return {
    currentVersion,
    expectedVersion: onDisk.at(-1)?.version ?? 0,
    applied,
    pending,
    upToDate: pending.length === 0,
  };
}

export interface MigrateResult {
  appliedNow: MigrationFile[];
  currentVersion: number;
}

/**
 * Apply pending migrations under a session advisory lock so that two API or worker processes
 * starting at once cannot race. Each transactional migration commits with its own ledger row,
 * so a failure part-way leaves earlier migrations applied and the failing one not recorded.
 */
export async function migrate(
  pool: SagaPool,
  directory: string,
  log: (message: string) => void = () => {},
): Promise<MigrateResult> {
  await ensureLedger(pool);

  const client = await pool.connect();
  const release = await acquireSessionAdvisoryLock(
    { query: (text, values) => client.query(text, values as unknown[] | undefined) },
    MIGRATION_LOCK_NAMESPACE,
  );

  const appliedNow: MigrationFile[] = [];
  try {
    const onDisk = await loadMigrations(directory);
    const appliedResult = await client.query<AppliedMigration>(
      'SELECT version, name, checksum, applied_at FROM public.schema_migrations ORDER BY version',
    );
    const { pending } = diffMigrations(onDisk, appliedResult.rows);

    for (const file of pending) {
      log(`applying ${file.filename}`);
      if (file.transactional) {
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [file.version, file.name, file.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new SagaError('INTERNAL_ERROR', `Migration ${file.filename} failed.`, {
            cause: error,
            details: { version: file.version, name: file.name },
          });
        }
      } else {
        // Non-transactional migrations (CREATE INDEX CONCURRENTLY) record their ledger row
        // separately; a crash between the two leaves the migration pending and re-runnable,
        // which is why such migrations must be written idempotently.
        try {
          await client.query(file.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [file.version, file.name, file.checksum],
          );
        } catch (error) {
          throw new SagaError('INTERNAL_ERROR', `Migration ${file.filename} failed.`, {
            cause: error,
            details: { version: file.version, name: file.name },
          });
        }
      }
      appliedNow.push(file);
    }

    const currentVersion = onDisk.at(-1)?.version ?? 0;
    return { appliedNow, currentVersion };
  } finally {
    await release();
    client.release();
  }
}
