import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SagaError } from '@saga/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from '../../../testing/harness.js';
import { diffMigrations, loadMigrations, migrate, migrationStatus, readApplied } from './migrate.js';
import type { SagaPool } from './pool.js';

const REPO_MIGRATIONS = new URL('../../../db/migrations', import.meta.url).pathname;

let pool: SagaPool;

beforeAll(() => {
  pool = createTestPool('saga-migrate-test');
});

afterAll(async () => {
  await pool.end();
});

describe('migration runner', () => {
  it('reports the test database as fully migrated', async () => {
    const status = await migrationStatus(pool, REPO_MIGRATIONS);
    expect(status.upToDate).toBe(true);
    expect(status.currentVersion).toBe(status.expectedVersion);
    expect(status.currentVersion).toBeGreaterThan(0);
    expect(status.pending).toEqual([]);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const result = await migrate(pool, REPO_MIGRATIONS);
    expect(result.appliedNow).toEqual([]);
  });

  it('records a checksum for every applied migration', async () => {
    const applied = await readApplied(pool);
    expect(applied.length).toBeGreaterThan(0);
    for (const row of applied) {
      expect(row.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('creates every domain schema and the extensions Saga depends on', async () => {
    const schemas = await pool.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
        WHERE nspname IN ('core','lore','quest','party','shrine','security')`,
    );
    expect(schemas.rows.map((row) => row.nspname).sort()).toEqual([
      'core',
      'lore',
      'party',
      'quest',
      'security',
      'shrine',
    ]);

    const extensions = await pool.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','vector','pg_trgm')`,
    );
    expect(extensions.rows.map((row) => row.extname).sort()).toEqual(['pg_trgm', 'pgcrypto', 'vector']);
  });

  it('has no repository, source or branch identity table anywhere', async () => {
    // Acceptance criterion 4 and section 3 of the specification: project identity is the
    // project name, never a VCS coordinate.
    const tables = await pool.query<{ tablename: string; schemaname: string }>(
      `SELECT schemaname, tablename FROM pg_tables
        WHERE schemaname IN ('core','lore','quest','party','shrine','security')`,
    );
    const names = tables.rows.map((row) => row.tablename);
    for (const forbidden of ['repositories', 'repository', 'sources', 'source', 'branches', 'branch', 'commits']) {
      expect(names, `table ${forbidden} must not exist`).not.toContain(forbidden);
    }

    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema IN ('core','lore','quest','party','shrine','security')
          AND column_name IN ('repository_url','repo_url','branch','branch_name','commit','commit_sha','svn_revision','remote_url')`,
    );
    expect(columns.rows).toEqual([]);
  });
});

describe('migration integrity', () => {
  it('refuses to run when an applied migration was edited', async () => {
    const onDisk = await loadMigrations(REPO_MIGRATIONS);
    const applied = await readApplied(pool);
    const tampered = applied.map((row, index) =>
      index === 0 ? { ...row, checksum: 'sha256:'.padEnd(71, '0') } : row,
    );
    expect(() => diffMigrations(onDisk, tampered)).toThrowError(SagaError);
    try {
      diffMigrations(onDisk, tampered);
    } catch (error) {
      expect((error as SagaError).code).toBe('SCHEMA_VERSION_MISMATCH');
      expect((error as SagaError).message).toMatch(/modified after it was applied/);
    }
  });

  it('refuses when a recorded migration is missing from disk', async () => {
    const onDisk = await loadMigrations(REPO_MIGRATIONS);
    const phantom = [
      ...(await readApplied(pool)),
      { version: 999, name: 'phantom', checksum: 'sha256:x', applied_at: new Date() },
    ];
    expect(() => diffMigrations(onDisk, phantom)).toThrowError(/missing from disk/);
  });

  it('rejects a migration directory with a version gap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saga-migrations-'));
    await writeFile(join(directory, '0001_first.sql'), 'SELECT 1;');
    await writeFile(join(directory, '0003_third.sql'), 'SELECT 1;');
    await expect(loadMigrations(directory)).rejects.toThrow(/gapless sequence/);
  });

  it('rejects a badly named migration file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saga-migrations-'));
    await writeFile(join(directory, 'oops.sql'), 'SELECT 1;');
    await expect(loadMigrations(directory)).rejects.toThrow(/0001_snake_case_name\.sql/);
  });
});

describe('concurrent migration runs', () => {
  it('serialises on the advisory lock without duplicating ledger rows', async () => {
    const before = await readApplied(pool);
    // Two racing processes on a fully migrated database must both no-op, and neither may
    // insert a duplicate ledger row.
    const [a, b] = await Promise.all([
      migrate(pool, REPO_MIGRATIONS),
      migrate(pool, REPO_MIGRATIONS),
    ]);
    expect(a.appliedNow).toEqual([]);
    expect(b.appliedNow).toEqual([]);
    const after = await readApplied(pool);
    expect(after).toHaveLength(before.length);
  });
});
