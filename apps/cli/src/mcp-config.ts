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
 * Write MCP server configuration for Codex and Claude Code.
 *
 * Both are written project-locally rather than into a user-global file: a machine may have
 * several Saga projects, and a global entry would point them all at one. The token is never
 * written here — the MCP server reads it from the keychain via `saga`'s own credential store.
 */
export interface McpConfigResult {
  written: string[];
  /** Files left alone because they no longer parse. Never overwritten — see `readJson`. */
  skipped: string[];
}

export function writeMcpConfig(input: McpConfigInput): McpConfigResult {
  const written: string[] = [];
  const skipped: string[] = [];

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

  // Codex: `.codex/config.json` at the project root.
  const codexPath = join(input.root, '.codex', 'config.json');
  const codex = readJson(codexPath);
  if (codex === 'unparseable') {
    skipped.push(codexPath);
  } else {
    const existing = codex ?? {};
    const codexServers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
    existing.mcpServers = { ...codexServers, saga: entry };
    writeJson(codexPath, existing);
    written.push(codexPath);
  }

  return { written, skipped };
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

export function mcpConfigPaths(root: string): string[] {
  return [join(root, '.mcp.json'), join(root, '.codex', 'config.json')];
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
