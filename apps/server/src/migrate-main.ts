#!/usr/bin/env node
/**
 * Compiled migration entry point, used by the `migrate` service in docker-compose and by the
 * systemd `saga-migrate.service` unit. `pnpm db:migrate` runs the same code through tsx.
 */
import { closePool, createPool, migrate } from '@saga/database';
import { errorMessage, sanitizeConnectionString } from '@saga/shared';
import { loadDotEnv } from '@saga/shared/dotenv';
import { MIGRATIONS_DIR } from './composition.js';

async function main(): Promise<void> {
  loadDotEnv();
  // Deliberately reads DATABASE_URL directly rather than the full configuration: applying
  // migrations must not depend on web or worker settings being present.
  const connectionString = process.env.DATABASE_URL ?? '';
  if (connectionString.length === 0) throw new Error('DATABASE_URL is not set.');

  const pool = createPool({ connectionString, max: 2, applicationName: 'saga-migrate' });
  console.log(`database: ${sanitizeConnectionString(connectionString)}`);
  try {
    const result = await migrate(pool, MIGRATIONS_DIR, (message) => console.log(`  ${message}`));
    console.log(
      result.appliedNow.length === 0
        ? `already at schema version ${result.currentVersion}`
        : `applied ${result.appliedNow.length} migration(s); now at schema version ${result.currentVersion}`,
    );
  } finally {
    await closePool(pool);
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
