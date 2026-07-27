import { closePool, createPool, migrate } from '@saga/database';
import { loadDotEnv } from '@saga/shared/dotenv';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url));

/**
 * Runs once before the integration and API suites: brings the test database to the current
 * schema. Individual tests truncate rather than re-migrate, which keeps the suite fast.
 */
export async function setup(): Promise<void> {
  loadDotEnv();

  const url = process.env.SAGA_TEST_DATABASE_URL;
  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      'SAGA_TEST_DATABASE_URL is required for the integration and api suites.\n' +
        'Copy .env.example to .env, or run: docker compose up -d postgres',
    );
  }

  const pool = createPool({ connectionString: url, max: 2, applicationName: 'saga-test-setup' });
  try {
    const result = await migrate(pool, MIGRATIONS_DIR);
    if (result.appliedNow.length > 0) {
      process.stdout.write(
        `[saga] applied ${result.appliedNow.length} migration(s) to the test database\n`,
      );
    }
  } finally {
    await closePool(pool);
  }
}

export async function teardown(): Promise<void> {
  // Nothing to do: the test database is left migrated so the next run starts faster.
}
