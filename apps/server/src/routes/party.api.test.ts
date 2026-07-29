import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiHarness, type ApiClient, type ApiHarness } from '../testing/api-harness.js';

let harness: ApiHarness;
let admin: ApiClient;
let projectId: string;
const PROJECT_NAME = 'Party API Project';

beforeAll(async () => {
  harness = await createApiHarness({ config: { PARTY_MODE: 'strict' } });
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  admin = await harness.loginAs('admin');
  const created = await admin.post('/api/projects', { name: PROJECT_NAME });
  projectId = created.body.project.id;
});

/** Start a session, activate a Quest, and return the agent run created alongside it. */
async function agent(task: string, client: string, workspace?: string) {
  const started = await admin.post('/api/sessions', {
    project: PROJECT_NAME,
    client,
    ...(workspace === undefined ? {} : { workspace_key: workspace, workspace_label: workspace }),
  });
  const activated = await admin.post(`/api/sessions/${started.body.session_id}/activate`, { task });
  return {
    sessionId: started.body.session_id as string,
    questId: activated.body.quest.id as string,
    // Party starts an agent run automatically when a session opens.
    runId: started.body.agent_run_id as string,
  };
}

describe('agent runs', () => {
  it('creates an agent run automatically when a session starts', async () => {
    const started = await admin.post('/api/sessions', {
      project: PROJECT_NAME,
      client: 'claude-code',
    });
    expect(started.body.agent_run_id).toMatch(/^[0-9a-f-]{36}$/);

    const runs = await admin.get(`/api/projects/${projectId}/party/runs`);
    expect(runs.body.items).toHaveLength(1);
    expect(runs.body.items[0].live).toBe(true);
    // The machine identity is never exposed.
    expect(Object.keys(runs.body.items[0])).not.toContain('workspace_key');
  });

  it('renews the lease on heartbeat', async () => {
    const a = await agent('Add CSV report export', 'claude-code');
    const response = await admin.post(`/api/party/runs/${a.runId}/heartbeat`, {});
    expect(response.status).toBe(200);
    expect(response.body.agent_run.live).toBe(true);
    expect(response.body.renewed_claims).toBe(0);
  });

  it('refuses a heartbeat after the run ends', async () => {
    const a = await agent('Add CSV report export', 'claude-code');
    await admin.post(`/api/party/runs/${a.runId}/end`, {});
    const response = await admin.post(`/api/party/runs/${a.runId}/heartbeat`, {});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('AGENT_RUN_EXPIRED');
  });
});

describe('claims', () => {
  it('grants an exclusive claim and denies the second with 409', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const b = await agent('Add report tables', 'codex');

    const body = {
      resource_type: 'migration_sequence',
      resource_key: 'packages/database/migrations',
      mode: 'exclusive',
    };

    const first = await admin.post('/api/party/claims', {
      ...body,
      agent_run_id: a.runId,
      work_item_id: a.questId,
    });
    expect(first.status).toBe(201);
    expect(first.body.claim.state).toBe('active');

    const second = await admin.post('/api/party/claims', {
      ...body,
      agent_run_id: b.runId,
      work_item_id: b.questId,
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('RESOURCE_CLAIM_CONFLICT');
    // The conflict shape is exactly what the specification documents.
    expect(second.body.error.details).toMatchObject({
      resource_type: 'migration_sequence',
      resource_key: 'packages/database/migrations',
      owner_client: 'claude-code',
    });
    expect(second.body.error.details.owner_quest_title).toBe('Add token-family migration');
    expect(second.body.error.details.lease_expires_at).toBeTruthy();
    // It must not leak the other agent's task text or files.
    expect(Object.keys(second.body.error.details)).not.toContain('scope');
  });

  it('lets shared claims coexist', async () => {
    const a = await agent('Read reports', 'claude-code');
    const b = await agent('Also read reports', 'codex');
    const body = {
      resource_type: 'module',
      resource_key: 'services/api/src/reports',
      mode: 'shared',
    };

    expect(
      (
        await admin.post('/api/party/claims', {
          ...body,
          agent_run_id: a.runId,
          work_item_id: a.questId,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await admin.post('/api/party/claims', {
          ...body,
          agent_run_id: b.runId,
          work_item_id: b.questId,
        })
      ).status,
    ).toBe(201);
  });

  it('renews claims alongside the heartbeat', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    await admin.post('/api/party/claims', {
      agent_run_id: a.runId,
      work_item_id: a.questId,
      resource_type: 'test_environment',
      resource_key: 'integration-db',
      mode: 'exclusive',
    });
    const heartbeat = await admin.post(`/api/party/runs/${a.runId}/heartbeat`, {});
    expect(heartbeat.body.renewed_claims).toBe(1);
  });

  it('releases a claim and refuses a release from another run', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const b = await agent('Other work', 'codex');
    const claim = await admin.post('/api/party/claims', {
      agent_run_id: a.runId,
      work_item_id: a.questId,
      resource_type: 'test_environment',
      resource_key: 'integration-db',
      mode: 'exclusive',
    });

    const foreign = await admin.post(`/api/party/claims/${claim.body.claim.id}/release`, {
      agent_run_id: b.runId,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('CLAIM_NOT_OWNED');

    const released = await admin.post(`/api/party/claims/${claim.body.claim.id}/release`, {
      agent_run_id: a.runId,
      reason: 'finished',
    });
    expect(released.body.claim.state).toBe('released');
  });

  it('requires confirmation and a reason to revoke, and records an audit entry', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const claim = await admin.post('/api/party/claims', {
      agent_run_id: a.runId,
      work_item_id: a.questId,
      resource_type: 'production_config',
      resource_key: 'prod.env',
      mode: 'exclusive',
    });

    const unconfirmed = await admin.post(`/api/party/claims/${claim.body.claim.id}/revoke`, {
      reason: 'stuck agent',
    });
    expect(unconfirmed.status).toBe(422);

    const revoked = await admin.post(`/api/party/claims/${claim.body.claim.id}/revoke`, {
      reason: 'the agent is stuck',
      confirm: true,
    });
    expect(revoked.body.claim.state).toBe('revoked');

    const audit = await admin.get('/api/shrine/audit?limit=20');
    const entry = audit.body.items.find(
      (item: { action: string }) => item.action === 'party.claim_revoked',
    );
    expect(entry.reason).toBe('the agent is stuck');
  });

  it('does not let a viewer revoke a claim', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const claim = await admin.post('/api/party/claims', {
      agent_run_id: a.runId,
      work_item_id: a.questId,
      resource_type: 'migration_sequence',
      resource_key: 'db/migrations',
      mode: 'exclusive',
    });

    const viewer = await harness.loginAs('viewer');
    const denied = await viewer.post(`/api/party/claims/${claim.body.claim.id}/revoke`, {
      reason: 'nope',
      confirm: true,
    });
    expect(denied.status).toBe(403);
  });
});

describe('claim idempotency and mode changes (spec 12.7)', () => {
  it('replays an identical acquisition instead of reporting a conflict', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const body = {
      agent_run_id: a.runId,
      work_item_id: a.questId,
      resource_type: 'migration_sequence',
      resource_key: 'packages/database/migrations',
      mode: 'exclusive',
    };
    const key = { 'idempotency-key': 'claim-retry-0001' };

    const first = await admin.post('/api/party/claims', body, key);
    expect(first.status).toBe(201);

    // An agent that retries after a timeout must not be blocked by its own first attempt.
    const replay = await admin.post('/api/party/claims', body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.claim.id).toBe(first.body.claim.id);

    const claims = await admin.get(`/api/projects/${projectId}/party/claims`);
    expect(claims.body.items).toHaveLength(1);
  });

  it('refuses the same key with a different body', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const key = { 'idempotency-key': 'claim-retry-0002' };
    const base = {
      agent_run_id: a.runId,
      work_item_id: a.questId,
      resource_type: 'migration_sequence',
      mode: 'exclusive',
    };

    await admin.post('/api/party/claims', { ...base, resource_key: 'one' }, key);
    const reused = await admin.post('/api/party/claims', { ...base, resource_key: 'two' }, key);

    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('changes the mode of a claim it already holds rather than adding a second', async () => {
    const a = await agent('Reshape the reports module', 'claude-code');
    const body = {
      agent_run_id: a.runId,
      work_item_id: a.questId,
      resource_type: 'module',
      resource_key: 'services/api/src/reports',
    };

    const shared = await admin.post('/api/party/claims', { ...body, mode: 'shared' });
    expect(shared.status).toBe(201);

    const exclusive = await admin.post('/api/party/claims', { ...body, mode: 'exclusive' });
    expect(exclusive.status).toBe(200);
    expect(exclusive.body.claim.id).toBe(shared.body.claim.id);
    expect(exclusive.body.claim.mode).toBe('exclusive');
    expect(exclusive.body.warnings.join(' ')).toMatch(/was changed to exclusive/);

    // One run holds one claim per resource: releasing it must leave nothing behind.
    const claims = await admin.get(`/api/projects/${projectId}/party/claims`);
    expect(claims.body.items).toHaveLength(1);
  });

  it('still refuses an upgrade another agent is blocking', async () => {
    const a = await agent('Reshape the reports module', 'claude-code');
    const b = await agent('Tidy the reports module', 'codex');
    const resource = { resource_type: 'module', resource_key: 'services/api/src/reports' };

    await admin.post('/api/party/claims', {
      ...resource,
      agent_run_id: a.runId,
      work_item_id: a.questId,
      mode: 'shared',
    });
    await admin.post('/api/party/claims', {
      ...resource,
      agent_run_id: b.runId,
      work_item_id: b.questId,
      mode: 'shared',
    });

    // `module` is advisory by default, so the upgrade is granted with a warning rather than
    // refused — but it must still see the other agent.
    const upgrade = await admin.post('/api/party/claims', {
      ...resource,
      agent_run_id: a.runId,
      work_item_id: a.questId,
      mode: 'exclusive',
    });
    expect(upgrade.status).toBe(200);
    expect(upgrade.body.warnings.join(' ')).toMatch(/other agent/);
  });
});

describe('status and overlap', () => {
  it('reports two agents on different Quests and their overlap', async () => {
    const a = await agent('Work on reports', 'claude-code');
    const b = await agent('Also work on reports', 'codex');

    await admin.patch(`/api/quests/${a.questId}`, {
      scope: { modules: ['services/api/src/reports'] },
    });
    await admin.patch(`/api/quests/${b.questId}`, {
      scope: { modules: ['services/api/src/reports'] },
    });

    const status = await admin.get(`/api/projects/${projectId}/party/status`);
    expect(status.body.mode).toBe('strict');
    expect(status.body.active_agents).toHaveLength(2);
    expect(
      status.body.overlaps.some((overlap: { kind: string }) => overlap.kind === 'module'),
    ).toBe(true);
  });

  it('escalates a shared workspace to critical', async () => {
    await agent('Work on reports', 'claude-code', 'machine-a:erp');
    await agent('Other work', 'codex', 'machine-a:erp');

    const status = await admin.get(`/api/projects/${projectId}/party/status`);
    const workspace = status.body.overlaps.find(
      (overlap: { kind: string }) => overlap.kind === 'workspace',
    );
    expect(workspace.severity).toBe('critical');
  });

  it('surfaces Party context inside session activation', async () => {
    const first = await agent('Implement report API endpoint', 'codex');
    await admin.patch(`/api/quests/${first.questId}`, {
      scope: { modules: ['services/api/src/reports'] },
    });

    const started = await admin.post('/api/sessions', {
      project: PROJECT_NAME,
      client: 'claude-code',
    });
    const activated = await admin.post(`/api/sessions/${started.body.session_id}/activate`, {
      task: 'Change the report serializer',
      scope: { modules: ['services/api/src/reports'] },
    });

    expect(activated.body.context.party.mode).toBe('strict');
    const agents = activated.body.context.party.active_agents as { client: string }[];
    expect(agents.some((entry) => entry.client === 'codex')).toBe(true);
  });
});

describe('file fingerprints', () => {
  it('reports a conflict when another Quest changed the same file', async () => {
    const a = await agent('Work on refresh tokens', 'claude-code');
    const b = await agent('Also work on refresh tokens', 'codex');

    await admin.post(`/api/party/runs/${b.runId}/fingerprints`, {
      agent_run_id: b.runId,
      work_item_id: b.questId,
      files: [{ path: 'src/auth/refresh.ts', current_hash: 'sha256:bbb' }],
    });

    const response = await admin.post(`/api/party/runs/${a.runId}/fingerprints`, {
      agent_run_id: a.runId,
      work_item_id: a.questId,
      files: [{ path: 'src/auth/refresh.ts', base_hash: 'sha256:aaa', current_hash: 'sha256:ccc' }],
    });

    expect(response.body.recorded).toBe(1);
    expect(response.body.conflicts[0]).toMatchObject({
      path: 'src/auth/refresh.ts',
      other_quest_title: 'Also work on refresh tokens',
    });
  });

  it('names the Agent Run as well as the Quest (spec 10.4)', async () => {
    const a = await agent('Work on refresh tokens', 'claude-code');
    const b = await agent('Also work on refresh tokens', 'codex');

    await admin.post(`/api/party/runs/${b.runId}/fingerprints`, {
      agent_run_id: b.runId,
      work_item_id: b.questId,
      files: [{ path: 'src/auth/refresh.ts', current_hash: 'sha256:bbb' }],
    });

    const response = await admin.post(`/api/party/runs/${a.runId}/fingerprints`, {
      agent_run_id: a.runId,
      work_item_id: a.questId,
      files: [{ path: 'src/auth/refresh.ts', base_hash: 'sha256:aaa', current_hash: 'sha256:ccc' }],
    });

    // The column was populated all along; the SELECT and the DTO simply dropped it, so a
    // conflict could only ever be attributed to a Quest.
    expect(response.body.conflicts[0]).toMatchObject({
      other_agent_run_id: b.runId,
      other_client: 'codex',
    });
    expect(response.body.conflicts[0].message).toContain('codex');
  });
});

describe('party mode off', () => {
  it('refuses coordination writes but leaves Quest working', async () => {
    const disabled = await createApiHarness({ config: { PARTY_MODE: 'off' } });
    try {
      await disabled.reset();
      const client = await disabled.loginAs('admin');
      const project = await client.post('/api/projects', { name: 'Party Off Project' });

      const started = await client.post('/api/sessions', {
        project: project.body.project.id,
        client: 'claude-code',
      });
      // No agent run is created when Party is off.
      expect(started.body.agent_run_id).toBeNull();

      const activated = await client.post(`/api/sessions/${started.body.session_id}/activate`, {
        task: 'Add CSV report export',
      });
      expect(activated.body.quest).not.toBeNull();

      // Checkpoints keep working: Lore and Quest do not depend on Party.
      const checkpoint = await client.post(`/api/sessions/${started.body.session_id}/checkpoints`, {
        expected_quest_revision: 0,
        kind: 'automatic',
        summary: 'works without Party',
        work_state: {
          goal: 'Add CSV report export',
          completed: [],
          in_progress: [],
          next_steps: [],
          blockers: [],
          decisions: [],
          changed_files: [],
          commands: [],
          tests: [],
        },
      });
      expect(checkpoint.status).toBe(201);

      const status = await client.get(`/api/projects/${project.body.project.id}/party/status`);
      expect(status.body.mode).toBe('off');
      expect(status.body.active_agents).toEqual([]);

      const runAttempt = await client.post('/api/party/runs', {
        session_id: started.body.session_id,
        agent_instance_id: 'x',
        client: 'claude-code',
      });
      expect(runAttempt.status).toBe(503);
      expect(runAttempt.body.error.code).toBe('PARTY_DISABLED');
    } finally {
      await disabled.close();
    }
  });
});
