/**
 * Database maintenance commands, importable without side effects.
 *
 * The entry points (`db/cli.ts`, `db/reset.ts`) own argument parsing and process exit; this
 * module owns the work. Keeping them apart matters: an entry point that runs on import makes
 * every importer inherit its argv parsing and its exit code.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { closePool, createPool, migrate, migrationStatus } from '@saga/database';
import { sanitizeConnectionString } from '@saga/shared';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const SEED_FILE = fileURLToPath(new URL('./seeds/development.sql', import.meta.url));

export const COMMANDS = ['migrate', 'status', 'seed', 'reset'] as const;
export type Command = (typeof COMMANDS)[number];

export function parseCommand(value: string | undefined): Command {
  const found = COMMANDS.find((command) => command === value);
  if (found === undefined) {
    throw new Error(`Usage: db/cli.ts <${COMMANDS.join('|')}> [--test]`);
  }
  return found;
}

export async function runDatabaseCommand(
  command: Command,
  useTestDatabase: boolean,
): Promise<void> {
  const connectionString = useTestDatabase
    ? (process.env.SAGA_TEST_DATABASE_URL ?? '')
    : (process.env.DATABASE_URL ?? '');

  if (connectionString.length === 0) {
    throw new Error(
      useTestDatabase ? 'SAGA_TEST_DATABASE_URL is not set.' : 'DATABASE_URL is not set.',
    );
  }

  const pool = createPool({ connectionString, applicationName: 'saga-db-cli', max: 2 });
  console.log(`database: ${sanitizeConnectionString(connectionString)}`);

  try {
    switch (command) {
      case 'migrate': {
        const result = await migrate(pool, MIGRATIONS_DIR, (message) =>
          console.log(`  ${message}`),
        );
        console.log(
          result.appliedNow.length === 0
            ? `already at version ${result.currentVersion}`
            : `applied ${result.appliedNow.length} migration(s); now at version ${result.currentVersion}`,
        );
        break;
      }
      case 'status': {
        const status = await migrationStatus(pool, MIGRATIONS_DIR);
        console.log(`current version : ${status.currentVersion}`);
        console.log(`expected version: ${status.expectedVersion}`);
        console.log(`up to date      : ${status.upToDate ? 'yes' : 'no'}`);
        for (const file of status.pending) console.log(`  pending: ${file.filename}`);
        break;
      }
      case 'seed': {
        const sql = await readFile(SEED_FILE, 'utf8');
        await pool.query(sql);
        console.log('development seed applied');
        break;
      }
      case 'reset': {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('db:reset is refused in production. Use forward-only migrations.');
        }
        await pool.query(
          `DROP SCHEMA IF EXISTS core, lore, quest, party, shrine, security CASCADE;
           DROP TABLE IF EXISTS public.schema_migrations CASCADE;`,
        );
        console.log('dropped all Saga schemas');
        const result = await migrate(pool, MIGRATIONS_DIR, (message) =>
          console.log(`  ${message}`),
        );
        console.log(`re-applied ${result.appliedNow.length} migration(s)`);
        break;
      }
    }
  } finally {
    await closePool(pool);
  }
}
