import { fileURLToPath } from 'node:url';
import { closePool, createPool, migrate } from '@saga/database';

/**
 * Brings the e2e database to the current schema and empties it, before the API starts.
 *
 * Emptying matters for more than tidiness: the bootstrap administrator is only created when
 * no user exists, so a database left over from another suite would leave the browser tests
 * with no credentials at all.
 *
 * This runs as the first half of the API `webServer` command, because it has to finish
 * before the server process reads the database — Playwright starts `webServer` entries
 * before `globalSetup`.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const SCHEMAS = ['core', 'lore', 'quest', 'party', 'shrine', 'security'];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL ?? '';
  if (connectionString.length === 0) {
    throw new Error('DATABASE_URL is not set for the e2e stack.');
  }

  const pool = createPool({ connectionString, max: 2, applicationName: 'saga-e2e-prepare' });
  try {
    await migrate(pool, MIGRATIONS_DIR);

    const tables = await pool.query<{ qualified: string }>(
      `SELECT format('%I.%I', schemaname, tablename) AS qualified
         FROM pg_tables
        WHERE schemaname = ANY($1)
          AND tablename <> 'schema_migrations'`,
      [SCHEMAS],
    );
    const targets = tables.rows.map((row) => row.qualified);
    if (targets.length > 0) {
      await pool.query(`TRUNCATE ${targets.join(', ')} RESTART IDENTITY CASCADE`);
    }
    process.stdout.write(`[saga] e2e database prepared (${targets.length} tables emptied)\n`);
  } finally {
    await closePool(pool);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
