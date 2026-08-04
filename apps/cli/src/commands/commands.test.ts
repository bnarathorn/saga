import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLocalChanges } from '../local-changes.js';
import { detectWorkspace, loadConfig } from '../workspace.js';
import { connectCommand, matchesProject } from './connect.js';
import { doctorCommand, guildHallUrl } from './doctor.js';
import { statusCommand } from './status.js';

/**
 * The CLI commands, driven end to end against a stubbed API.
 *
 * `SAGA_TOKEN` is set throughout, which makes `CredentialStore` resolve from the environment
 * and spawn no keychain helper — these tests must not depend on what is installed on the
 * machine running them.
 */

const SERVER = 'http://saga.test';
const PROJECT_ID = '00000000-0000-4000-8000-000000000010';

let root: string;
let home: string;
let cwd: string;
let stdout: string;
let stderr: string;

const originalEnv = { ...process.env };

interface Stub {
  status?: number;
  body: unknown;
}

/** Path -> response. An unstubbed request throws, so a test cannot pass by not calling. */
function stubFetch(routes: Record<string, Stub | (() => Stub)>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const key = `${init?.method ?? 'GET'} ${url}`;
      calls.push(key);
      const entry = routes[key] ?? routes[url];
      if (entry === undefined) throw new Error(`Unstubbed request: ${key}`);
      const stub = typeof entry === 'function' ? entry() : entry;
      return new Response(JSON.stringify(stub.body), {
        status: stub.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      id: PROJECT_ID,
      name: 'ERP Backoffice',
      name_key: 'erp backoffice',
      description: null,
      status: 'active',
      memory_revision: 4,
      active_context_snapshot_id: 'snap-1',
      lore_approval_mode: 'auto',
      aliases: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    },
  };
}

const ME = {
  authenticated: true,
  actor_type: 'agent',
  agent: { project_id: PROJECT_ID, name: 'erp agent', scopes: ['quest:write'] },
};

function healthBody(version = '0.1.0') {
  return { status: 'healthy', version, checked_at: new Date().toISOString(), checks: [] };
}

const connectRoutes = {
  [`${SERVER}/health/live`]: { body: { status: 'ok' } },
  [`${SERVER}/api/auth/me`]: { body: ME },
  [`${SERVER}/api/shrine/health`]: { body: healthBody() },
  [`${SERVER}/api/projects/${PROJECT_ID}`]: { body: project() },
  [`POST ${SERVER}/api/projects/${PROJECT_ID}/context`]: {
    body: { bootstrap_required: false, project: { memory_revision: 4 } },
  },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saga-cmd-'));
  home = mkdtempSync(join(tmpdir(), 'saga-cmd-home-'));
  cwd = process.cwd();
  process.chdir(root);
  process.env.XDG_CONFIG_HOME = home;
  process.env.XDG_DATA_HOME = join(home, 'data');
  // `saga connect` writes Codex's user-global configuration, which must never be the real one.
  process.env.CODEX_HOME = join(home, 'codex');
  process.env.SAGA_TOKEN = 'agent-token';
  resetLocalChanges();

  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe('saga connect', () => {
  it('binds the folder, writes the project file and the MCP configuration', async () => {
    stubFetch(connectRoutes);

    const code = await connectCommand(['--server', SERVER]);

    expect(code).toBe(0);
    expect(stdout).toContain('Project: ERP Backoffice');
    expect(existsSync(join(root, '.saga', 'project.yaml'))).toBe(true);
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);

    const bindings = loadConfig().bindings;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ projectId: PROJECT_ID, serverUrl: SERVER });
  });

  it('verifies API compatibility and reports it (spec 13.1 step 7)', async () => {
    const { calls } = stubFetch(connectRoutes);
    await connectCommand(['--server', SERVER]);

    expect(calls).toContain(`GET ${SERVER}/api/shrine/health`);
    expect(stdout).toContain('API compatibility');
  });

  it('refuses an incompatible server before writing anything locally', async () => {
    stubFetch({
      ...connectRoutes,
      [`${SERVER}/api/shrine/health`]: { body: healthBody('9.0.0') },
    });

    const code = await connectCommand(['--server', SERVER]);

    expect(code).toBe(1);
    expect(stderr).toContain('the server speaks 9.0.0');
    expect(stderr).toContain('Nothing was changed locally.');
    expect(existsSync(join(root, '.saga', 'project.yaml'))).toBe(false);
    expect(loadConfig().bindings).toHaveLength(0);
  });

  it('refuses when --project names a different project than the token is bound to', async () => {
    stubFetch(connectRoutes);

    const code = await connectCommand(['--server', SERVER, '--project', 'Warehouse']);

    expect(code).toBe(1);
    expect(stderr).toContain('ERP Backoffice');
    expect(stderr).toContain('Nothing was changed locally.');
    expect(loadConfig().bindings).toHaveLength(0);
  });

  it('accepts --project by name or by id', async () => {
    stubFetch(connectRoutes);
    expect(await connectCommand(['--server', SERVER, '--project', 'erp backoffice'])).toBe(0);
    expect(await connectCommand(['--server', SERVER, '--project', PROJECT_ID])).toBe(0);
  });

  it('binds anyway when the token may not read server health', async () => {
    // `/api/shrine/health` needs `shrine:health`, which a token approved with a narrower scope
    // set than the default does not carry. Being unable to *check* the version is not a reason
    // to refuse a folder that /health/live has already answered for.
    stubFetch({
      ...connectRoutes,
      [`${SERVER}/api/shrine/health`]: {
        status: 403,
        body: {
          error: {
            code: 'SCOPE_REQUIRED',
            message: 'This agent token does not carry a scope granting "shrine:health".',
            details: {},
            request_id: 'req_1',
          },
        },
      },
    });

    const code = await connectCommand(['--server', SERVER]);

    expect(code).toBe(0);
    expect(stdout).toContain('not verified (SCOPE_REQUIRED)');
    expect(loadConfig().bindings).toHaveLength(1);
  });

  it('reports an unreachable server without touching local files', async () => {
    stubFetch({ [`${SERVER}/health/live`]: { status: 500, body: {} } });

    const code = await connectCommand(['--server', SERVER]);

    expect(code).toBe(1);
    expect(stderr).toContain('Could not reach the Saga API');
    expect(existsSync(join(root, '.saga'))).toBe(false);
  });

  it('records the project name in .saga/project.yaml but never a token', async () => {
    stubFetch(connectRoutes);
    await connectCommand(['--server', SERVER]);

    const contents = readFileSync(join(root, '.saga', 'project.yaml'), 'utf8');
    expect(contents).toContain('project: ERP Backoffice');
    expect(contents).not.toContain('agent-token');
  });
});

describe('matchesProject', () => {
  it('matches on id and on name, case-insensitively', () => {
    const target = { id: PROJECT_ID, name: 'ERP Backoffice' };
    expect(matchesProject(PROJECT_ID, target)).toBe(true);
    expect(matchesProject('erp backoffice', target)).toBe(true);
    expect(matchesProject('  ERP Backoffice  ', target)).toBe(true);
    expect(matchesProject('Warehouse', target)).toBe(false);
  });
});

describe('guildHallUrl', () => {
  it('reports the server origin, because nginx serves the console from it', () => {
    expect(guildHallUrl('https://saga.example.internal')).toBe(
      'https://saga.example.internal (served from this origin).',
    );
    // A non-default port is part of the origin, not a dev-server tell.
    expect(guildHallUrl('https://saga.example.internal:8443/')).toBe(
      'https://saga.example.internal:8443 (served from this origin).',
    );
    // Compose publishes both halves on 8080.
    expect(guildHallUrl('http://localhost:8080')).toBe(
      'http://localhost:8080 (served from this origin).',
    );
  });

  it('points at Vite only when talking to the dev API port on loopback', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(guildHallUrl(`http://${host}:4319`)).toBe(
        `http://${host}:4320 (development stack: Vite serves Guild Hall separately).`,
      );
    }
    // Same port, but reached over the network: nginx is in front, so the console is here.
    expect(guildHallUrl('https://saga.example.internal:4319')).toBe(
      'https://saga.example.internal:4319 (served from this origin).',
    );
  });

  it('keeps a path prefix and survives an unparseable URL', () => {
    expect(guildHallUrl('https://example.test/saga')).toBe(
      'https://example.test/saga (served from this origin).',
    );
    expect(guildHallUrl('not a url')).toBe('not a url');
  });
});

describe('saga doctor', () => {
  const doctorRoutes = {
    ...connectRoutes,
    [`${SERVER}/health/ready`]: { body: { status: 'healthy', checks: [] } },
    [`${SERVER}/api/projects/${PROJECT_ID}/party/status`]: {
      body: { mode: 'strict', project_id: PROJECT_ID, active_agents: [], claims: [], overlaps: [] },
    },
  };

  it('exits zero when everything the CLI needs is in place', async () => {
    stubFetch(doctorRoutes);
    await connectCommand(['--server', SERVER]);
    stdout = '';

    const code = await doctorCommand(['--json']);

    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { checks: { name: string; status: string }[] };
    const compatibility = report.checks.find((check) => check.name === 'api compatibility');
    expect(compatibility?.status).toBe('ok');
  });

  it('fails on an incompatible API version rather than reporting it as ok', async () => {
    stubFetch(doctorRoutes);
    await connectCommand(['--server', SERVER]);
    stdout = '';

    stubFetch({ ...doctorRoutes, [`${SERVER}/api/shrine/health`]: { body: healthBody('9.0.0') } });
    const code = await doctorCommand(['--json']);

    expect(code).toBe(1);
    const report = JSON.parse(stdout) as { checks: { name: string; status: string }[] };
    expect(report.checks.find((check) => check.name === 'api compatibility')?.status).toBe(
      'failure',
    );
  });

  it('exits non-zero when the folder is not bound at all', async () => {
    stubFetch(doctorRoutes);
    const code = await doctorCommand(['--json', '--server', SERVER]);
    expect(code).toBe(1);

    const report = JSON.parse(stdout) as { checks: { name: string; status: string }[] };
    expect(report.checks.find((check) => check.name === 'project binding')?.status).toBe('failure');
  });

  it('treats a warning as non-fatal so it is usable in CI', async () => {
    stubFetch(doctorRoutes);
    await connectCommand(['--server', SERVER]);
    stdout = '';

    const code = await doctorCommand(['--json']);
    const report = JSON.parse(stdout) as { warnings: number };

    // A plain-HTTP server URL is a warning; it must not fail the command.
    expect(report.warnings).toBeGreaterThan(0);
    expect(code).toBe(0);
  });
});

describe('saga status', () => {
  function agent(overrides: Record<string, unknown> = {}) {
    return {
      id: '00000000-0000-4000-8000-000000000300',
      project_id: PROJECT_ID,
      session_id: '00000000-0000-4000-8000-000000000310',
      work_item_id: '00000000-0000-4000-8000-000000000001',
      agent_instance_id: 'a1',
      client: 'claude-code',
      workspace_label: 'elsewhere:other-folder',
      state: 'active',
      live: true,
      heartbeat_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      started_at: new Date().toISOString(),
      ended_at: null,
      quest_title: 'Somebody else’s Quest',
      scope: {},
      claims: [],
      ...overrides,
    };
  }

  function quest(overrides: Record<string, unknown> = {}) {
    return {
      id: '00000000-0000-4000-8000-000000000001',
      project_id: PROJECT_ID,
      parent_work_item_id: null,
      title: 'Somebody else’s Quest',
      objective: null,
      status: 'in_progress',
      priority: 'normal',
      scope: {},
      revision: 1,
      latest_checkpoint_id: null,
      created_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      completed_at: null,
      archived_at: null,
      ...overrides,
    };
  }

  function statusRoutes(agents: unknown[], quests: unknown[]) {
    return {
      ...connectRoutes,
      [`${SERVER}/api/projects/${PROJECT_ID}/party/status`]: {
        body: {
          mode: 'strict',
          project_id: PROJECT_ID,
          active_agents: agents,
          claims: [],
          overlaps: [],
        },
      },
      [`${SERVER}/api/projects/${PROJECT_ID}/quests?limit=100`]: {
        body: { items: quests, next_cursor: null, has_more: false },
      },
    };
  }

  it('does not report another workspace’s Quest as active here', async () => {
    stubFetch(connectRoutes);
    await connectCommand(['--server', SERVER]);
    stdout = '';

    stubFetch(statusRoutes([agent()], [quest()]));
    const code = await statusCommand(['--json']);

    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      quests: { open: number; active_here: string | null };
      notes: string[];
    };
    // The old behaviour reported the first in-progress Quest in the whole project.
    expect(report.quests.active_here).toBeNull();
    expect(report.quests.open).toBe(1);
    expect(report.notes.join(' ')).toContain('none is attached to an agent run in this folder');
  });

  it('reports the Quest of an agent run in this folder', async () => {
    stubFetch(connectRoutes);
    await connectCommand(['--server', SERVER]);
    stdout = '';

    const label = detectWorkspace(root).workspaceLabel;
    stubFetch(
      statusRoutes(
        [
          agent(),
          agent({
            id: 'run-here',
            workspace_label: label,
            work_item_id: '00000000-0000-4000-8000-000000000002',
            quest_title: 'The Quest in this folder',
          }),
        ],
        [quest(), quest({ id: '00000000-0000-4000-8000-000000000002' })],
      ),
    );

    await statusCommand(['--json']);
    const report = JSON.parse(stdout) as { quests: { active_here: string | null } };
    expect(report.quests.active_here).toBe('The Quest in this folder');
  });

  it('reports an unbound folder without pretending to know a project', async () => {
    stubFetch(connectRoutes);
    const code = await statusCommand(['--json', '--server', SERVER]);

    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { project: unknown };
    // The token still resolves a project even with no binding, so status stays useful.
    expect(report.project).not.toBeNull();
  });
});
