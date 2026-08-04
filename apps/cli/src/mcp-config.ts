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
  /** Files left alone because writing to them would damage what is there, with the reason why. */
  skipped: { path: string; reason: string }[];
  /** Files that already configure Saga, left byte-for-byte as they are. */
  unchanged: string[];
}

export function writeMcpConfig(input: McpConfigInput): McpConfigResult {
  const written: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
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
    skipped.push({
      path: claudePath,
      reason:
        'it exists but is not valid JSON. Saga left it untouched rather than discarding the ' +
        'servers it defines. Fix the JSON and re-run `saga connect`',
    });
  } else {
    const existing = claude ?? {};
    const claudeServers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
    existing.mcpServers = { ...claudeServers, saga: entry };
    writeJson(claudePath, existing);
    written.push(claudePath);
  }

  // Codex: `mcp_servers` in its own TOML configuration, which is user-global.
  const codexPath = codexConfigPath();
  const codex = writeCodexEntry(codexPath, input);
  if (codex === 'written') written.push(codexPath);
  else if (codex === 'unchanged') unchanged.push(codexPath);
  else
    skipped.push({
      path: codexPath,
      reason:
        'it defines `mcp_servers` as an inline table, and appending a second definition of that ' +
        'key would make the file unparseable. Add a `saga` entry to that table by hand: ' +
        '{ command = "saga", args = ["mcp"] }',
    });

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

/**
 * A real `[mcp_servers.saga]` table header, not a mention of one.
 *
 * Anchored to the start of a line and rejecting a leading `#`, because a commented-out example
 * is exactly what someone who tried to configure this by hand leaves behind — and treating that
 * as configured would report success while Codex still has no Saga tools.
 */
const CODEX_SERVER_TABLE = /^[^\S\n]*\[mcp_servers\.saga\]/m;

/** `mcp_servers = { … }` defines the same key as an inline table; appending would duplicate it. */
const CODEX_INLINE_TABLE = /^[^\S\n]*mcp_servers[^\S\n]*=/m;

/**
 * Append a Codex `mcp_servers.saga` entry, or leave the file exactly as it is.
 *
 * Deliberately no TOML parser: rewriting a file Saga does not own would reformat it and drop
 * its comments. Appending is safe because the two tables go last, so no later key can be
 * captured by them, and an entry that already exists is never rewritten — a user who edited
 * theirs keeps their edit.
 */
function writeCodexEntry(path: string, input: McpConfigInput): 'written' | 'unchanged' | 'skipped' {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (CODEX_SERVER_TABLE.test(existing)) return 'unchanged';
  // Appending `[mcp_servers.saga]` under an inline `mcp_servers = { … }` defines the key twice,
  // which makes the whole file unparseable — Codex would lose every server, not just gain none.
  if (CODEX_INLINE_TABLE.test(existing)) return 'skipped';

  const block =
    `[mcp_servers.saga]\n` +
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
      configured: existsSync(codexPath) && CODEX_SERVER_TABLE.test(readFileSync(codexPath, 'utf8')),
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
