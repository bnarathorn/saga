import { removeAgentInstructions } from '../agent-instructions.js';
import { CredentialStore } from '../credentials.js';
import { mcpConfigStatus } from '../mcp-config.js';
import { detectWorkspace, findBinding, loadConfig } from '../workspace.js';
import { parseFlags } from './connect.js';

/**
 * `saga logout` — undo what `saga connect` put on this machine for this server.
 *
 * Two things, because `connect` wrote two. The credentials are the sign-out itself. The session
 * policy in `AGENTS.md` and `CLAUDE.md` is the other half: it is what tells an agent to call
 * Saga before it does anything else, and a folder that keeps it after signing out sends every
 * agent that opens it at a server it can no longer authenticate to — a failed tool call, not a
 * signed-out folder. `--no-agent-instructions` keeps the block, matching the flag that declines
 * to write it in the first place; they are shared project files either way.
 *
 * The MCP registration is only reported, never removed: `.mcp.json` is a file the team may have
 * its own servers in, and Codex's is user-global and shared by every project on the machine.
 */
export async function logoutCommand(argv: string[]): Promise<number> {
  const out = process.stdout;
  const flags = parseFlags(argv);
  const workspace = detectWorkspace();
  const config = loadConfig();
  const serverUrl =
    flags.server ?? findBinding(config, workspace.root)?.serverUrl ?? config.serverUrl;
  if (serverUrl === null || serverUrl === undefined) {
    process.stderr.write('No server is configured for this folder.\n');
    return 1;
  }
  const credentials = new CredentialStore();
  await credentials.clear(serverUrl);
  out.write(`Removed the stored credentials for ${serverUrl}.\n`);
  // Clearing storage does not clear the environment, and `get` prefers the environment: without
  // this line the next command still authenticates and logout looks like it failed.
  if ((await credentials.backend()) === 'environment') {
    out.write(
      'SAGA_TOKEN is still set in this shell, and it takes precedence over stored credentials.\n' +
        '  Run `unset SAGA_TOKEN` to finish signing out of this session.\n',
    );
  }

  if (flags.agentInstructions === false) {
    out.write('Session policy: left in place (--no-agent-instructions).\n');
    return 0;
  }

  const instructions = removeAgentInstructions(workspace.root);
  for (const file of instructions.removed) {
    out.write(`Session policy removed: ${file} (the \`saga:begin\` block; the rest is intact).\n`);
  }
  for (const file of instructions.deleted) {
    out.write(`Session policy removed: ${file} (deleted — it held nothing else).\n`);
  }
  for (const file of instructions.skipped) {
    out.write(`Session policy NOT removed: ${file.path} — ${file.reason}.\n`);
  }
  if (instructions.removed.length === 0 && instructions.deleted.length === 0) {
    out.write('Session policy: no `saga:begin` block to remove.\n');
  } else {
    out.write(
      '  These are project files the whole team shares: commit the removal, or the next\n' +
        '  checkout still carries the policy.\n',
    );
  }

  // Removing the policy stops an agent being *told* to use Saga; the tools stay registered until
  // these are edited, and this command will not edit them on the user's behalf.
  const registered = mcpConfigStatus(workspace.root)
    .filter((entry) => entry.configured)
    .map((entry) => entry.path);
  if (registered.length > 0) {
    out.write(
      `Saga is still registered as an MCP server in:\n` +
        registered.map((path) => `    ${path}\n`).join('') +
        '  The tools remain available to an agent that reaches for them. Remove the `saga`\n' +
        '  entry by hand to take them away entirely.\n',
    );
  }

  return 0;
}
