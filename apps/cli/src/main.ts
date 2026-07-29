#!/usr/bin/env node
import { errorMessage, isSagaError } from '@saga/shared';
import { registerCommand, runCli } from './cli.js';
import { connectCommand, parseFlags } from './commands/connect.js';
import { doctorCommand } from './commands/doctor.js';
import { statusCommand } from './commands/status.js';
import { CredentialStore } from './credentials.js';
import { describeLocalChanges } from './local-changes.js';
import { detectWorkspace, findBinding, loadConfig } from './workspace.js';

registerCommand('connect', connectCommand);
registerCommand('status', statusCommand);
registerCommand('doctor', doctorCommand);

registerCommand('mcp', async () => {
  // Imported lazily so `saga status` does not pay for the MCP SDK.
  const { runMcpServer } = await import('./mcp/main.js');
  await runMcpServer(process.env.SAGA_MCP_CLIENT ?? 'saga-mcp');
  // The stdio transport keeps the process alive until the host closes it.
  return new Promise<number>(() => {});
});

registerCommand('logout', async (argv) => {
  const flags = parseFlags(argv);
  const workspace = detectWorkspace();
  const config = loadConfig();
  const serverUrl =
    flags.server ?? findBinding(config, workspace.root)?.serverUrl ?? config.serverUrl;
  if (serverUrl === null || serverUrl === undefined) {
    process.stderr.write('No server is configured for this folder.\n');
    return 1;
  }
  await new CredentialStore().clear(serverUrl);
  process.stdout.write(`Removed the stored credentials for ${serverUrl}.\n`);
  return 0;
});

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // A CLI error must say what failed, whether local work is safe, and what to do next —
    // never a raw stack trace unless --debug was given.
    if (process.argv.includes('--debug')) {
      console.error(error);
    } else if (isSagaError(error)) {
      process.stderr.write(`\n${error.message}\n  (${error.code})\n`);
      if (error.retryable) process.stderr.write('  Retrying is safe.\n');
      process.stderr.write(`  ${describeLocalChanges()}\n`);
    } else {
      process.stderr.write(
        `\n${errorMessage(error)}\n  ${describeLocalChanges()}\n  Run with --debug for detail.\n`,
      );
    }
    process.exitCode = 1;
  },
);
