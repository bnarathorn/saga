import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpConfigStatus, removeMcpConfig, renderMcpConfig, writeMcpConfig } from './mcp-config.js';
import {
  detectWorkspace,
  findBinding,
  readProjectFile,
  upsertBinding,
  writeProjectFile,
  type SagaCliConfig,
} from './workspace.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saga-ws-'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * These are the acceptance tests for spec 21.5: all three local project forms must connect
 * identically, and none of them may become project identity.
 */
describe('workspace detection — all three project forms', () => {
  it('detects a plain folder with no version control at all', () => {
    const info = detectWorkspace(root);
    expect(info.kind).toBe('plain');
    expect(info.root).toBe(root);
    expect(info.workspaceKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('detects a Git working copy that has no remote', () => {
    // Deliberately only `.git/` with no config and no remote: Saga must not care.
    mkdirSync(join(root, '.git'), { recursive: true });
    const info = detectWorkspace(root);
    expect(info.kind).toBe('git');
    expect(info.root).toBe(root);
  });

  it('detects an SVN working copy', () => {
    mkdirSync(join(root, '.svn'), { recursive: true });
    const info = detectWorkspace(root);
    expect(info.kind).toBe('svn');
  });

  it('detects a Mercurial working copy', () => {
    mkdirSync(join(root, '.hg'), { recursive: true });
    expect(detectWorkspace(root).kind).toBe('mercurial');
  });

  it('produces the same shape of identity for every project form', () => {
    const plain = detectWorkspace(root);

    const gitRoot = mkdtempSync(join(tmpdir(), 'saga-git-'));
    mkdirSync(join(gitRoot, '.git'), { recursive: true });
    const git = detectWorkspace(gitRoot);

    const svnRoot = mkdtempSync(join(tmpdir(), 'saga-svn-'));
    mkdirSync(join(svnRoot, '.svn'), { recursive: true });
    const svn = detectWorkspace(svnRoot);

    for (const info of [plain, git, svn]) {
      expect(info.workspaceKey).toMatch(/^[0-9a-f]{32}$/);
      expect(info.workspaceLabel).toMatch(/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/);
      // No VCS value is ever part of identity.
      expect(info.vcsRevision).toBeNull();
      expect(JSON.stringify(info)).not.toContain('remote');
      expect(JSON.stringify(info)).not.toContain('branch');
    }
  });

  it('never exposes the absolute path in the workspace label', () => {
    const info = detectWorkspace(root);
    expect(info.workspaceLabel).not.toContain('/');
    expect(info.workspaceLabel).not.toContain(root);
  });

  it('walks up to the project root from a subdirectory', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    const nested = join(root, 'services', 'api', 'src');
    mkdirSync(nested, { recursive: true });
    expect(detectWorkspace(nested).root).toBe(root);
  });

  it('walks up to a .saga binding even without version control', () => {
    mkdirSync(join(root, '.saga'), { recursive: true });
    writeFileSync(join(root, '.saga', 'project.yaml'), 'version: 1\nproject: Test\n');
    const nested = join(root, 'deep', 'nested');
    mkdirSync(nested, { recursive: true });
    expect(detectWorkspace(nested).root).toBe(root);
  });

  it('gives the same workspace key for the same folder and a different one otherwise', () => {
    const a = detectWorkspace(root);
    const b = detectWorkspace(root);
    expect(a.workspaceKey).toBe(b.workspaceKey);

    const other = mkdtempSync(join(tmpdir(), 'saga-other-'));
    expect(detectWorkspace(other).workspaceKey).not.toBe(a.workspaceKey);
  });
});

describe('project file', () => {
  it('round-trips the project name', () => {
    writeProjectFile(root, 'ERP Backoffice');
    expect(readProjectFile(root)).toEqual({ project: 'ERP Backoffice' });
  });

  it('quotes a name that needs it', () => {
    writeProjectFile(root, 'Payments: EU & UK');
    expect(readProjectFile(root)).toEqual({ project: 'Payments: EU & UK' });
  });

  it('records inspection hints and never a secret', () => {
    const path = writeProjectFile(root, 'ERP Backoffice');
    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('inspection:');
    expect(contents).toContain('.env*');
    expect(contents).toContain('Never put tokens');
    // The warning names them; no line may actually *assign* one.
    const assignments = contents
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /^\s*\S*(token|password|secret|credential)\S*\s*:\s*\S/i.test(line));
    expect(assignments).toEqual([]);
  });

  it('returns null when there is no project file', () => {
    expect(readProjectFile(root)).toBeNull();
  });
});

describe('bindings', () => {
  const base: SagaCliConfig = {
    version: 1,
    serverUrl: 'https://saga.test',
    bindings: [],
    preferences: { defaultClient: 'saga-cli', json: false },
  };

  it('adds and replaces a binding for the same root', () => {
    const first = upsertBinding(base, {
      root: '/a',
      projectId: 'p1',
      projectName: 'One',
      serverUrl: 'https://saga.test',
      workspaceKey: 'k1',
      boundAt: new Date().toISOString(),
    });
    expect(first.bindings).toHaveLength(1);

    const replaced = upsertBinding(first, {
      root: '/a',
      projectId: 'p2',
      projectName: 'Two',
      serverUrl: 'https://saga.test',
      workspaceKey: 'k1',
      boundAt: new Date().toISOString(),
    });
    expect(replaced.bindings).toHaveLength(1);
    expect(findBinding(replaced, '/a')?.projectId).toBe('p2');
  });

  it('keeps bindings for different roots side by side', () => {
    let config = base;
    for (const root of ['/a', '/b']) {
      config = upsertBinding(config, {
        root,
        projectId: `p${root}`,
        projectName: root,
        serverUrl: 'https://saga.test',
        workspaceKey: 'k',
        boundAt: new Date().toISOString(),
      });
    }
    expect(config.bindings).toHaveLength(2);
    expect(findBinding(config, '/b')?.projectName).toBe('/b');
  });
});

describe('MCP configuration', () => {
  // Codex reads one user-global file, so every test here points CODEX_HOME at a temporary
  // directory: none of them may touch the configuration of the machine running them.
  let codexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'saga-codex-'));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
  });

  it('writes project-local configuration for Claude Code and Codex', () => {
    const { written } = writeMcpConfig({
      root,
      serverUrl: 'https://saga.test',
      projectRef: 'project-uuid',
    });
    expect(written).toHaveLength(2);

    const claude = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(claude.mcpServers.saga).toMatchObject({
      command: 'saga',
      args: ['mcp'],
      env: { SAGA_SERVER_URL: 'https://saga.test', SAGA_PROJECT: 'project-uuid' },
    });

    // Codex reads TOML from its own home, and nothing from the project folder: a
    // `.codex/config.json` beside the code would look configured and do nothing.
    const codex = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    expect(codex).toContain('[mcp_servers.saga]');
    expect(codex).toContain('command = "saga"');
    expect(codex).toContain('SAGA_PROJECT = "project-uuid"');
    expect(existsSync(join(root, '.codex', 'config.json'))).toBe(false);
  });

  it('appends to a Codex configuration without disturbing what is already there', () => {
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\n');
    writeMcpConfig({ root, serverUrl: 'https://saga.test', projectRef: 'p' });

    const codex = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    expect(codex).toContain('model = "gpt-5"');
    expect(codex).toContain('[mcp_servers.other]');
    expect(codex).toContain('[mcp_servers.saga]');
  });

  it('never rewrites a Codex entry the user may have edited', () => {
    const original = '[mcp_servers.saga]\ncommand = "/opt/saga/bin/saga"\nargs = ["mcp"]\n';
    writeFileSync(join(codexHome, 'config.toml'), original);

    const { written, unchanged } = writeMcpConfig({
      root,
      serverUrl: 'https://saga.test',
      projectRef: 'p',
    });

    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(original);
    expect(unchanged).toContain(join(codexHome, 'config.toml'));
    expect(written).toEqual([join(root, '.mcp.json')]);
  });

  it('treats a commented-out Codex entry as absent, because Codex does', () => {
    // What someone who tried to configure this by hand leaves behind. Reading it as configured
    // would report success while Codex still has no Saga tools.
    writeFileSync(join(codexHome, 'config.toml'), '# [mcp_servers.saga]\n# command = "saga"\n');

    const { written } = writeMcpConfig({ root, serverUrl: 'https://saga.test', projectRef: 'p' });

    expect(written).toContain(join(codexHome, 'config.toml'));
    expect(mcpConfigStatus(root).every((entry) => entry.configured)).toBe(true);
  });

  it('refuses to append beside an inline mcp_servers table it would make unparseable', () => {
    const original = 'mcp_servers = { other = { command = "other" } }\n';
    writeFileSync(join(codexHome, 'config.toml'), original);

    const { written, skipped } = writeMcpConfig({
      root,
      serverUrl: 'https://saga.test',
      projectRef: 'p',
    });

    // Two definitions of one key is a TOML error: Codex would lose every server, not just gain
    // none. Claude Code's file is still written.
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(original);
    expect(written).toEqual([join(root, '.mcp.json')]);
    expect(skipped[0]?.path).toBe(join(codexHome, 'config.toml'));
    expect(skipped[0]?.reason).toContain('inline table');
  });

  it('reports Saga as configured only where an entry actually names it', () => {
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5"\n');
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } }));

    expect(mcpConfigStatus(root).every((entry) => !entry.configured)).toBe(true);

    writeMcpConfig({ root, serverUrl: 'https://saga.test', projectRef: 'p' });
    expect(mcpConfigStatus(root).every((entry) => entry.configured)).toBe(true);
  });

  it('never writes a token into MCP configuration', () => {
    writeMcpConfig({ root, serverUrl: 'https://saga.test', projectRef: 'p' });
    const contents = readFileSync(join(root, '.mcp.json'), 'utf8');
    expect(contents).not.toMatch(/token|password|secret/i);
  });

  it('preserves other MCP servers already configured', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
    );
    writeMcpConfig({ root, serverUrl: 'https://saga.test', projectRef: 'p' });
    const claude = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(claude.mcpServers.other).toEqual({ command: 'other' });
    expect(claude.mcpServers.saga).toBeDefined();
  });

  it('renders the same configuration for a user to paste', () => {
    const rendered = renderMcpConfig({
      root,
      serverUrl: 'https://saga.test',
      projectRef: 'p',
    });
    expect(JSON.parse(rendered).mcpServers.saga.args).toEqual(['mcp']);
  });

  describe('removeMcpConfig', () => {
    it('undoes the write: both files stop registering Saga', () => {
      writeMcpConfig({ root, serverUrl: 'https://saga.test', projectRef: 'p' });

      const result = removeMcpConfig(root);

      expect(mcpConfigStatus(root).every((entry) => !entry.configured)).toBe(true);
      // `.mcp.json` configured nothing else, so it goes; Codex's file is user-global and stays.
      expect(result.deleted).toEqual([join(root, '.mcp.json')]);
      expect(result.removed).toEqual([join(codexHome, 'config.toml')]);
      expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    });

    it('keeps every other MCP server the files define', () => {
      writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
      );
      writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\n');
      writeMcpConfig({ root, serverUrl: 'https://saga.test', projectRef: 'p' });

      removeMcpConfig(root);

      const claude = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
      expect(claude.mcpServers).toEqual({ other: { command: 'other' } });

      const codex = readFileSync(join(codexHome, 'config.toml'), 'utf8');
      expect(codex).toBe('model = "gpt-5"\n\n[mcp_servers.other]\n');
    });

    it('takes the `[mcp_servers.saga.env]` sub-table with the entry, and nothing after it', () => {
      writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5"\n');
      writeMcpConfig({ root, serverUrl: 'https://saga.test', projectRef: 'p' });
      writeFileSync(
        join(codexHome, 'config.toml'),
        `${readFileSync(join(codexHome, 'config.toml'), 'utf8')}\n[mcp_servers.later]\ncommand = "later"\n`,
      );

      removeMcpConfig(root);

      const codex = readFileSync(join(codexHome, 'config.toml'), 'utf8');
      expect(codex).not.toContain('saga');
      expect(codex).toBe('model = "gpt-5"\n\n[mcp_servers.later]\ncommand = "later"\n');
    });

    it('removes a Codex entry the user edited by hand, which is what removal means', () => {
      writeFileSync(
        join(codexHome, 'config.toml'),
        '[mcp_servers.saga]\ncommand = "/opt/saga/bin/saga"\nargs = ["mcp"]\n',
      );

      const result = removeMcpConfig(root);

      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe('');
      expect(result.removed).toContain(join(codexHome, 'config.toml'));
    });

    it('reports a file that never registered Saga as absent, and leaves it alone', () => {
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } }));
      writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5"\n');

      const result = removeMcpConfig(root);

      expect(result.absent).toEqual([join(root, '.mcp.json'), join(codexHome, 'config.toml')]);
      expect(result.removed).toEqual([]);
      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n');
    });

    it('refuses a `.mcp.json` that no longer parses rather than discarding what it defines', () => {
      const original = '{ "mcpServers": { "saga": ';
      writeFileSync(join(root, '.mcp.json'), original);

      const result = removeMcpConfig(root);

      expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(original);
      expect(result.skipped[0]?.path).toBe(join(root, '.mcp.json'));
      expect(result.skipped[0]?.reason).toContain('not valid JSON');
    });

    it('refuses an inline Codex table, which it cannot edit without a TOML parser', () => {
      const original = 'mcp_servers = { saga = { command = "saga" } }\n';
      writeFileSync(join(codexHome, 'config.toml'), original);

      const result = removeMcpConfig(root);

      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(original);
      expect(result.skipped[0]?.path).toBe(join(codexHome, 'config.toml'));
      expect(result.skipped[0]?.reason).toContain('inline table');
    });

    it('leaves a commented-out Codex entry alone, because Codex never read it', () => {
      const original = '# [mcp_servers.saga]\n# command = "saga"\n';
      writeFileSync(join(codexHome, 'config.toml'), original);

      const result = removeMcpConfig(root);

      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(original);
      expect(result.absent).toContain(join(codexHome, 'config.toml'));
    });
  });
});
