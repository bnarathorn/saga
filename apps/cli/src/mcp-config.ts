import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { noteLocalChange } from './local-changes.js';

export interface McpConfigInput {
  root: string;
  serverUrl: string;
  projectRef: string;
}

/**
 * Write MCP server configuration for Claude Code and Codex.
 *
 * Claude Code is written project-locally: a machine may have several Saga projects, and a
 * global entry would point them all at one. Codex has no project-level MCP configuration —
 * it reads `mcp_servers` from `$CODEX_HOME/config.toml`, defaulting to `~/.codex/config.toml`
 * — so its entry is necessarily global. A project-local file Codex never opens looks like
 * configuration and does nothing, which is the worse failure: the agent then has no Saga tools
 * at all, and reaches for the API by hand instead.
 *
 * The token is never written here — the MCP server reads it from the keychain via `saga`'s own
 * credential store.
 */
export interface McpConfigResult {
  written: string[];
  /** Files left alone because they no longer parse. Never overwritten — see `readJson`. */
  skipped: string[];
  /** Files that already configure Saga, left byte-for-byte as they are. */
  unchanged: string[];
}

export function writeMcpConfig(input: McpConfigInput): McpConfigResult {
  const written: string[] = [];
  const skipped: string[] = [];
  const unchanged: string[] = [];

  const entry = {
    command: 'saga',
    args: ['mcp'],
    env: {
      SAGA_SERVER_URL: input.serverUrl,
      SAGA_PROJECT: input.projectRef,
    },
  };

  // Claude Code: `.mcp.json` at the project root.
  const claudePath = join(input.root, '.mcp.json');
  const claude = readJson(claudePath);
  if (claude === 'unparseable') {
    skipped.push(claudePath);
  } else {
    const existing = claude ?? {};
    const claudeServers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
    existing.mcpServers = { ...claudeServers, saga: entry };
    writeJson(claudePath, existing);
    written.push(claudePath);
  }

  // Codex: `mcp_servers` in its own TOML configuration, which is user-global.
  const codexPath = codexConfigPath();
  if (writeCodexEntry(codexPath, input) === 'written') written.push(codexPath);
  else unchanged.push(codexPath);

  return { written, skipped, unchanged };
}

/** Render the same configuration for a user to paste elsewhere. */
export function renderMcpConfig(input: McpConfigInput): string {
  return JSON.stringify(
    {
      mcpServers: {
        saga: {
          command: 'saga',
          args: ['mcp'],
          env: { SAGA_SERVER_URL: input.serverUrl, SAGA_PROJECT: input.projectRef },
        },
      },
    },
    null,
    2,
  );
}

/** Where Codex reads `mcp_servers` from. `CODEX_HOME` wins, as it does for Codex itself. */
export function codexConfigPath(): string {
  const home = process.env.CODEX_HOME;
  return home !== undefined && home.length > 0
    ? join(home, 'config.toml')
    : join(homedir(), '.codex', 'config.toml');
}

const CODEX_SERVER_TABLE = '[mcp_servers.saga]';

/**
 * Append a Codex `mcp_servers.saga` entry, or leave the file exactly as it is.
 *
 * Deliberately no TOML parser: rewriting a file Saga does not own would reformat it and drop
 * its comments. Appending is safe because the two tables go last, so no later key can be
 * captured by them, and an entry that already exists is never rewritten — a user who edited
 * theirs keeps their edit.
 */
function writeCodexEntry(path: string, input: McpConfigInput): 'written' | 'unchanged' {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (existing.includes(CODEX_SERVER_TABLE)) return 'unchanged';

  const block =
    `${CODEX_SERVER_TABLE}\n` +
    `command = "saga"\n` +
    `args = ["mcp"]\n\n` +
    `[mcp_servers.saga.env]\n` +
    `SAGA_SERVER_URL = ${tomlString(input.serverUrl)}\n` +
    `SAGA_PROJECT = ${tomlString(input.projectRef)}\n`;

  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${existing}${separator}${block}`);
  noteLocalChange(path);
  return 'written';
}

/** A TOML basic string escapes the same characters a JSON string does. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function mcpConfigPaths(root: string): string[] {
  return [join(root, '.mcp.json'), codexConfigPath()];
}

/**
 * Whether each configuration file actually registers Saga. A Codex configuration exists on
 * most machines regardless of Saga, so its presence proves nothing on its own.
 */
export function mcpConfigStatus(root: string): { path: string; configured: boolean }[] {
  const claudePath = join(root, '.mcp.json');
  const claude = readJson(claudePath);
  const codexPath = codexConfigPath();

  return [
    {
      path: claudePath,
      configured:
        claude !== null &&
        claude !== 'unparseable' &&
        typeof claude.mcpServers === 'object' &&
        claude.mcpServers !== null &&
        'saga' in (claude.mcpServers as Record<string, unknown>),
    },
    {
      path: codexPath,
      configured:
        existsSync(codexPath) && readFileSync(codexPath, 'utf8').includes(CODEX_SERVER_TABLE),
    },
  ];
}

export function globalClaudeConfigPath(): string {
  return join(homedir(), '.claude.json');
}

/** `null` = no file yet; `'unparseable'` = a file exists that we must not clobber. */
function readJson(path: string): Record<string, unknown> | null | 'unparseable' {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // A hand-edited file that no longer parses must not be silently overwritten: merging into
    // `{}` would drop every other MCP server the user had configured there.
    return 'unparseable';
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  noteLocalChange(path);
}
