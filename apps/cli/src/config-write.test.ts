import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetLocalChanges } from './local-changes.js';
import {
  configPath,
  loadConfig,
  saveConfig,
  updateConfig,
  upsertBinding,
  type ProjectBinding,
} from './workspace.js';

let home: string;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

function binding(overrides: Partial<ProjectBinding> = {}): ProjectBinding {
  return {
    root: '/tmp/one',
    projectId: '00000000-0000-4000-8000-000000000001',
    projectName: 'ERP Backoffice',
    serverUrl: 'http://localhost:4319',
    workspaceKey: 'k1',
    boundAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'saga-cfg-'));
  process.env.XDG_CONFIG_HOME = home;
  resetLocalChanges();
});

afterEach(() => {
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
});

describe('config writes (spec 13.2)', () => {
  it('writes atomically and leaves no temporary file behind', () => {
    saveConfig({
      version: 1,
      serverUrl: 'http://localhost:4319',
      bindings: [binding()],
      preferences: { defaultClient: 'saga-cli', json: false },
    });

    expect(loadConfig().bindings).toHaveLength(1);
    const dir = readdirSync(join(home, 'saga'));
    expect(dir).toEqual(['config.json']);
  });

  it('keeps the previous file readable when the new content is written', () => {
    saveConfig({
      version: 1,
      serverUrl: 'http://a',
      bindings: [binding()],
      preferences: { defaultClient: 'saga-cli', json: false },
    });
    const before = readFileSync(configPath(), 'utf8');
    expect(JSON.parse(before)).toMatchObject({ serverUrl: 'http://a' });

    saveConfig({ ...loadConfig(), serverUrl: 'http://b' });
    expect(loadConfig().serverUrl).toBe('http://b');
  });

  it('re-reads inside the lock, so a binding written by another run is not dropped', () => {
    // Exactly the lost update `saga connect` used to cause: the command loads the config at
    // start-up, another run binds a different folder, and the first run writes back its stale
    // copy. `updateConfig` re-reads under the lock, so both bindings survive.
    const stale = loadConfig();

    saveConfig(upsertBinding(loadConfig(), binding({ root: '/tmp/other', workspaceKey: 'k2' })));

    updateConfig((current) => {
      expect(current.bindings.map((entry) => entry.root)).toContain('/tmp/other');
      return upsertBinding(current, binding({ root: '/tmp/one' }));
    });

    expect(stale.bindings).toHaveLength(0);
    expect(
      loadConfig()
        .bindings.map((entry) => entry.root)
        .sort(),
    ).toEqual(['/tmp/one', '/tmp/other']);
  });

  it('replaces the binding for a root rather than duplicating it', () => {
    updateConfig((current) => upsertBinding(current, binding({ projectName: 'First' })));
    updateConfig((current) => upsertBinding(current, binding({ projectName: 'Second' })));

    const bindings = loadConfig().bindings;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.projectName).toBe('Second');
  });

  it('breaks a stale lock left by a killed process instead of hanging', () => {
    const lock = `${configPath()}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '');
    // Backdate it past the stale window.
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lock, old, old);

    updateConfig((current) => upsertBinding(current, binding()));

    expect(loadConfig().bindings).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });
});
