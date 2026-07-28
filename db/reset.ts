#!/usr/bin/env tsx
/**
 * Drop every Saga schema and re-apply all migrations from scratch.
 *
 * Development and tests only: `runDatabaseCommand` refuses to run this when
 * NODE_ENV=production, because production upgrades are forward-only (spec 7).
 *
 *   pnpm db:reset            # DATABASE_URL
 *   tsx db/reset.ts --test   # SAGA_TEST_DATABASE_URL
 */
import { loadDotEnv } from '@saga/shared/dotenv';
import { runDatabaseCommand } from './commands.js';

async function main(): Promise<void> {
  loadDotEnv();
  await runDatabaseCommand('reset', process.argv.includes('--test'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
