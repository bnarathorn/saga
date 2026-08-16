import { removeAgentInstructions } from '../agent-instructions.js';
import { CredentialStore } from '../credentials.js';
import { codexConfigPath, removeMcpConfig } from '../mcp-config.js';
import { detectWorkspace, findBinding, loadConfig } from '../workspace.js';
import { parseFlags } from './connect.js';

/**
 * `saga logout` — undo what `saga connect` put on this machine for this server.
 *
 * Everything `connect` wrote, because a half-undone sign-out is what leaves an agent confused.
 * The credentials are the sign-out itself. The session policy in `AGENTS.md` and `CLAUDE.md` is
 * what tells an agent to call Saga before it does anything else, and the MCP registration is
 * what gives it the tools to call: keep either and the agent still reaches for a server it can
 * no longer authenticate to, which surfaces as a failed tool call rather than as a signed-out
 * folder.
 *
 * Each half can be declined, because each lands somewhere that is not only Saga's:
 * `--no-agent-instructions` keeps the policy in those shared project files, and `--keep-mcp`
 * keeps the registration — Codex's configuration is user-global, so removing the entry there
 * removes it for every project on the machine.
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
  } else {
    const instructions = removeAgentInstructions(workspace.root);
    for (const file of instructions.removed) {
      out.write(
        `Session policy removed: ${file} (the \`saga:begin\` block; the rest is intact).\n`,
      );
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
  }

  if (flags.mcp === false) {
    out.write('MCP configuration: left in place (--keep-mcp).\n');
    return 0;
  }

  const mcp = removeMcpConfig(workspace.root);
  for (const file of mcp.removed) {
    out.write(`MCP configuration removed: ${file} (the \`saga\` entry; other servers kept).\n`);
  }
  for (const file of mcp.deleted) {
    out.write(`MCP configuration removed: ${file} (deleted — it configured nothing else).\n`);
  }
  for (const file of mcp.skipped) {
    out.write(`MCP configuration NOT removed: ${file.path} — ${file.reason}.\n`);
  }
  if (mcp.removed.length === 0 && mcp.deleted.length === 0) {
    out.write('MCP configuration: no `saga` entry to remove.\n');
  } else if (mcp.removed.includes(codexConfigPath()) || mcp.deleted.includes(codexConfigPath())) {
    // Codex has no project-level MCP configuration, so its entry was never this folder's alone.
    out.write(
      `  ${codexConfigPath()} is user-global: any other Saga folder on this machine has lost\n` +
        '  its Codex tools too, until `saga connect` runs there again.\n',
    );
  }

  return 0;
}
