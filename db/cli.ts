#!/usr/bin/env tsx
/**
 * Database maintenance entry point: `pnpm db:migrate | db:status | db:seed | db:reset`.
 *
 * `reset` is refused when NODE_ENV=production — production upgrades are forward-only.
 */
import { loadDotEnv } from '@saga/shared/dotenv';
import { parseCommand, runDatabaseCommand } from './commands.js';

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  await runDatabaseCommand(parseCommand(args[0]), args.includes('--test'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
