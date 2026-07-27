import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
export function writeMcpConfig(input: McpConfigInput): string[] {
  const written: string[] = [];

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
  const claude = readJson(claudePath) ?? {};
  const claudeServers = (claude.mcpServers as Record<string, unknown> | undefined) ?? {};
  claude.mcpServers = { ...claudeServers, saga: entry };
  writeJson(claudePath, claude);
  written.push(claudePath);

  // Codex: `.codex/config.json` at the project root.
  const codexPath = join(input.root, '.codex', 'config.json');
  const codex = readJson(codexPath) ?? {};
  const codexServers = (codex.mcpServers as Record<string, unknown> | undefined) ?? {};
  codex.mcpServers = { ...codexServers, saga: entry };
  writeJson(codexPath, codex);
  written.push(codexPath);

  return written;
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

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // A hand-edited file that no longer parses must not be silently overwritten.
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
