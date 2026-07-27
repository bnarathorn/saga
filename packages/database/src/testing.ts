import { fileURLToPath } from 'node:url';
import { SagaError } from '@saga/shared';
import { createPool, type SagaPool } from './pool.js';
import { migrate } from './migrate.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

export function testDatabaseUrl(): string {
  const url = process.env.SAGA_TEST_DATABASE_URL;
  if (url === undefined || url.trim().length === 0) {
    throw new SagaError(
      'INTERNAL_ERROR',
      'SAGA_TEST_DATABASE_URL is required to run integration tests.',
    );
  }
  return url;
}

export function createTestPool(applicationName = 'saga-test'): SagaPool {
  return createPool({
    connectionString: testDatabaseUrl(),
    max: 8,
    statementTimeoutMs: 30_000,
    applicationName,
    onError: (error) => {
      console.error('test pool error', error.message);
    },
  });
}

export async function migrateTestDatabase(pool: SagaPool): Promise<void> {
  await migrate(pool, MIGRATIONS_DIR);
}

const TRUNCATION_ORDER = [
  'party.claims',
  'party.resources',
  'party.agent_runs',
  'quest.checkpoints',
  'quest.sessions',
  'quest.work_item_dependencies',
  'quest.work_items',
  'lore.memory_links',
  'lore.memory_update_items',
  'lore.memory_updates',
  'lore.context_snapshots',
  'lore.memory_versions',
  'lore.memory_items',
  'shrine.jobs',
  'shrine.system_events',
  'shrine.service_instances',
  'core.outbox_events',
  'core.idempotency_records',
  'core.project_aliases',
  'core.projects',
  'security.audit_logs',
  'security.device_codes',
  'security.agent_tokens',
  'security.web_sessions',
  'security.users',
];

/**
 * Wipe every domain table between tests. Tables that do not exist yet (earlier phases of a
 * bisect, or a partially migrated database) are skipped rather than failing the suite.
 */
export async function truncateAll(pool: SagaPool): Promise<void> {
  const existing = await pool.query<{ qualified: string }>(
    `SELECT format('%I.%I', schemaname, tablename) AS qualified
       FROM pg_tables
      WHERE schemaname IN ('core','lore','quest','party','shrine','security')`,
  );
  const present = new Set(existing.rows.map((row) => row.qualified));
  const targets = TRUNCATION_ORDER.filter((table) => present.has(table));
  if (targets.length === 0) return;
  await pool.query(`TRUNCATE ${targets.join(', ')} RESTART IDENTITY CASCADE`);
}
