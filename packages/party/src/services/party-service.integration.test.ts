import type { Project } from '@saga/core';
import { PgOutboxRepository, PgProjectRepository, ProjectService } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { QuestRepository, QuestService, SessionService } from '@saga/quest';
import { JobService, PgJobRepository, PgSystemEventRepository } from '@saga/shrine';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, truncateAll } from '../../../../testing/harness.js';
import { PartyRepository } from '../repositories/party-repository.js';
import { PartyService } from './party-service.js';

let pool: SagaPool;
let projects: ProjectService;
let quests: QuestService;
let sessions: SessionService;
let project: Project;

const partyRepo = new PartyRepository();
const questRepo = new QuestRepository();

function buildParty(mode: 'off' | 'advisory' | 'strict', leaseSeconds = 90): PartyService {
  return new PartyService({
    pool,
    party: partyRepo,
    quests: questRepo,
    outbox: new PgOutboxRepository(),
    mode,
    agentRunLeaseSeconds: leaseSeconds,
    claimLeaseSeconds: leaseSeconds,
  });
}

let party: PartyService;

beforeEach(async () => {
  if (pool === undefined) {
    pool = createTestPool('saga-party-test');
    const outbox = new PgOutboxRepository();
    const projectRepo = new PgProjectRepository();
    const jobs = new JobService({
      pool,
      jobs: new PgJobRepository(),
      events: new PgSystemEventRepository(),
      jobLeaseSeconds: 60,
      jobMaxAttempts: 5,
    });
    projects = new ProjectService({ pool, projects: projectRepo, outbox });
    quests = new QuestService({ pool, quests: questRepo, projects: projectRepo, outbox, jobs });
    sessions = new SessionService({
      pool,
      quests: questRepo,
      questService: quests,
      projects: projectRepo,
      outbox,
      party: {},
      abandonAfterMinutes: 180,
    });
  }
  await truncateAll(pool);
  project = await projects.create({ name: 'Party Test Project' });
  party = buildParty('strict');
});

afterAll(async () => {
  await pool?.end();
});

/** Start a session, activate it on a task, and start an agent run for it. */
async function agent(task: string, client: string, workspaceKey?: string) {
  const started = await sessions.start({ project, client, workspaceKey });
  const activated = await sessions.activate({ sessionId: started.session.id, project, task });
  const run = await party.startRun({
    projectId: project.id,
    sessionId: started.session.id,
    agentInstanceId: `${client}-${started.session.id.slice(0, 8)}`,
    client,
    workspaceKey: workspaceKey ?? null,
  });
  await party.attachQuest(started.session.id, activated.quest!.id);
  return { sessionId: started.session.id, questId: activated.quest!.id, runId: run.id, run };
}

describe('agent runs', () => {
  it('starts a live run with a lease', async () => {
    const a = await agent('Add CSV report export', 'claude-code');
    expect(a.run.state).toBe('active');
    expect(a.run.leaseExpiresAt).not.toBeNull();
    expect(a.run.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('renews the lease on heartbeat without writing a system event', async () => {
    const a = await agent('Add CSV report export', 'claude-code');
    const before = a.run.leaseExpiresAt!.getTime();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await party.heartbeat({ agentRunId: a.runId });
    expect(result.run.leaseExpiresAt!.getTime()).toBeGreaterThan(before);

    const events = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM shrine.system_events WHERE event_type LIKE 'party.%'`,
    );
    expect(Number(events.rows[0]!.count)).toBe(0);
  });

  it('refuses a heartbeat for an ended run', async () => {
    const a = await agent('Add CSV report export', 'claude-code');
    await party.endRun({ agentRunId: a.runId });
    await expect(party.heartbeat({ agentRunId: a.runId })).rejects.toMatchObject({
      code: 'AGENT_RUN_EXPIRED',
    });
  });

  it('sanitises a workspace label so no absolute path is stored', async () => {
    const started = await sessions.start({ project, client: 'codex' });
    const run = await party.startRun({
      projectId: project.id,
      sessionId: started.session.id,
      agentInstanceId: 'codex-1',
      client: 'codex',
      workspaceLabel: '/home/alice/projects/erp-backoffice',
    });
    expect(run.workspaceLabel).toBe('erp-backoffice');
  });
});

describe('claims', () => {
  it('grants an uncontested exclusive claim', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const result = await party.acquireClaim({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      resourceType: 'migration_sequence',
      resourceKey: 'db/migrations',
      mode: 'exclusive',
    });
    expect(result.claim.state).toBe('active');
    expect(result.claim.resourcePolicy).toBe('exclusive');
  });

  it('lets exactly one of two concurrent exclusive claims win', async () => {
    // Acceptance criterion 15.
    const a = await agent('Add token-family migration', 'claude-code');
    const b = await agent('Add report tables', 'codex');

    const request = (runId: string, questId: string) =>
      party.acquireClaim({
        projectId: project.id,
        agentRunId: runId,
        workItemId: questId,
        resourceType: 'migration_sequence',
        resourceKey: 'db/migrations',
        mode: 'exclusive',
      });

    const results = await Promise.allSettled([
      request(a.runId, a.questId),
      request(b.runId, b.questId),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'RESOURCE_CLAIM_CONFLICT' });
    // The conflict names the owner so the loser can coordinate.
    expect(rejected.reason.details).toMatchObject({
      resource_type: 'migration_sequence',
      resource_key: 'db/migrations',
    });
    expect(rejected.reason.details.owner_quest_title).toBeTruthy();
  });

  it('lets shared claims coexist where policy permits', async () => {
    const a = await agent('Read the logs', 'claude-code');
    const b = await agent('Also read the logs', 'codex');

    for (const who of [a, b]) {
      const result = await party.acquireClaim({
        projectId: project.id,
        agentRunId: who.runId,
        workItemId: who.questId,
        resourceType: 'module',
        resourceKey: 'services/api/src/reports',
        mode: 'shared',
      });
      expect(result.claim.state).toBe('active');
    }

    const claims = await partyRepo.listClaimsForProject(pool, project.id, false);
    expect(claims).toHaveLength(2);
  });

  it('warns on an advisory overlap without blocking', async () => {
    const a = await agent('Work on auth', 'claude-code');
    const b = await agent('Also work on auth', 'codex');

    await party.acquireClaim({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      resourceType: 'module',
      resourceKey: 'services/api/src/auth',
      mode: 'shared',
    });
    const second = await party.acquireClaim({
      projectId: project.id,
      agentRunId: b.runId,
      workItemId: b.questId,
      resourceType: 'module',
      resourceKey: 'services/api/src/auth',
      mode: 'shared',
    });
    expect(second.claim.state).toBe('active');
    expect(second.warnings.join(' ')).toContain('Coordinate');
  });

  it('is idempotent when the same run re-claims', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const first = await party.acquireClaim({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      resourceType: 'migration_sequence',
      resourceKey: 'db/migrations',
      mode: 'exclusive',
    });
    const again = await party.acquireClaim({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      resourceType: 'migration_sequence',
      resourceKey: 'db/migrations',
      mode: 'exclusive',
    });
    expect(again.alreadyHeld).toBe(true);
    expect(again.claim.id).toBe(first.claim.id);
  });

  it('grants a claim once the previous lease has expired', async () => {
    const shortLease = buildParty('strict', -1);
    const a = await agent('Add token-family migration', 'claude-code');
    const b = await agent('Add report tables', 'codex');

    await shortLease.acquireClaim({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      resourceType: 'migration_sequence',
      resourceKey: 'db/migrations',
      mode: 'exclusive',
    });

    // The first claim's lease is already in the past; the second must be granted.
    const second = await party.acquireClaim({
      projectId: project.id,
      agentRunId: b.runId,
      workItemId: b.questId,
      resourceType: 'migration_sequence',
      resourceKey: 'db/migrations',
      mode: 'exclusive',
    });
    expect(second.claim.state).toBe('active');
    expect(second.claim.agentRunId).toBe(b.runId);
  });

  it('releases a claim idempotently and refuses a foreign release', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const b = await agent('Other work', 'codex');
    const claim = await party.acquireClaim({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      resourceType: 'migration_sequence',
      resourceKey: 'db/migrations',
      mode: 'exclusive',
    });

    await expect(
      party.releaseClaim({ claimId: claim.claim.id, agentRunId: b.runId }),
    ).rejects.toMatchObject({ code: 'CLAIM_NOT_OWNED' });

    const released = await party.releaseClaim({
      claimId: claim.claim.id,
      agentRunId: a.runId,
      reason: 'done',
    });
    expect(released.state).toBe('released');

    const again = await party.releaseClaim({ claimId: claim.claim.id, agentRunId: a.runId });
    expect(again.state).toBe('released');
  });

  it('revokes a claim administratively with a reason', async () => {
    const a = await agent('Add token-family migration', 'claude-code');
    const claim = await party.acquireClaim({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      resourceType: 'migration_sequence',
      resourceKey: 'db/migrations',
      mode: 'exclusive',
    });
    const revoked = await party.revokeClaim({
      claimId: claim.claim.id,
      reason: 'the agent is stuck',
      actorLabel: 'admin@example.test',
    });
    expect(revoked.state).toBe('revoked');
    expect(revoked.releaseReason).toContain('admin@example.test');
  });
});

describe('lease expiry after an unclean stop', () => {
  it('expires the run, releases its claims, and leaves the Quest untouched', async () => {
    const shortLease = buildParty('strict', -1);
    const a = await agent('Add token-family migration', 'claude-code');

    // The run and its claim are created with an already-lapsed lease: an agent that stopped
    // without ending cleanly.
    const stale = await shortLease.startRun({
      projectId: project.id,
      sessionId: a.sessionId,
      agentInstanceId: 'crashed',
      client: 'claude-code',
    });
    await shortLease.acquireClaim({
      projectId: project.id,
      agentRunId: stale.id,
      workItemId: a.questId,
      resourceType: 'test_environment',
      resourceKey: 'integration-db',
      mode: 'exclusive',
    });

    await quests.createCheckpoint({
      sessionId: a.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'progress before the crash',
      workState: {
        goal: 'Add token-family migration',
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

    const reaped = await party.reapExpiredRuns();
    expect(reaped.expired).toContain(stale.id);
    expect(reaped.releasedClaims).toBeGreaterThanOrEqual(1);

    const expired = await party.getRun(stale.id);
    expect(expired.state).toBe('expired');

    // The durable Quest and its checkpoint survive.
    const quest = await quests.get(a.questId);
    expect(quest.revision).toBe(1);
    expect(await quests.listCheckpoints(a.questId)).toHaveLength(1);

    // Another agent can now take the resource.
    const b = await agent('Other migration work', 'codex');
    const granted = await party.acquireClaim({
      projectId: project.id,
      agentRunId: b.runId,
      workItemId: b.questId,
      resourceType: 'test_environment',
      resourceKey: 'integration-db',
      mode: 'exclusive',
    });
    expect(granted.claim.state).toBe('active');
  });

  it('emits an agent-expired event', async () => {
    const shortLease = buildParty('strict', -1);
    const started = await sessions.start({ project, client: 'claude-code' });
    await shortLease.startRun({
      projectId: project.id,
      sessionId: started.session.id,
      agentInstanceId: 'crashed',
      client: 'claude-code',
    });

    await party.reapExpiredRuns();
    const events = await pool.query<{ topic: string }>(
      `SELECT topic FROM core.outbox_events WHERE topic = 'party.agent_expired'`,
    );
    expect(events.rows).toHaveLength(1);
  });
});

describe('overlap detection against real data', () => {
  it('reports two agents on different Quests touching the same module', async () => {
    const a = await agent('Work on reports', 'claude-code');
    const b = await agent('Also work on reports', 'codex');

    await quests.update(a.questId, { scope: { modules: ['services/api/src/reports'] } });
    await quests.update(b.questId, { scope: { modules: ['services/api/src/reports'] } });

    const status = await party.status(project.id);
    expect(status.runs).toHaveLength(2);
    expect(status.overlaps.some((overlap) => overlap.kind === 'module')).toBe(true);
  });

  it('escalates when both agents share a workspace', async () => {
    const a = await agent('Work on reports', 'claude-code', 'machine-a:erp');
    const b = await agent('Other work', 'codex', 'machine-a:erp');
    void a;
    void b;

    const status = await party.status(project.id);
    const workspace = status.overlaps.find((overlap) => overlap.kind === 'workspace');
    expect(workspace?.severity).toBe('critical');
    expect(workspace?.same_workspace).toBe(true);
  });

  it('renders concise Party context for an agent', async () => {
    const a = await agent('Work on reports', 'claude-code');
    const b = await agent('Implement report API endpoint', 'codex');
    await quests.update(b.questId, { scope: { apis: ['/v1/reports/export'] } });
    await party.acquireClaim({
      projectId: project.id,
      agentRunId: b.runId,
      workItemId: b.questId,
      resourceType: 'test_environment',
      resourceKey: 'integration-db',
      mode: 'exclusive',
    });

    const context = await party.contextFor({
      projectId: project.id,
      sessionId: a.sessionId,
      workItemId: a.questId,
    });
    expect(context.rendered).toContain('Parallel work');
    expect(context.rendered).toContain('codex');
    expect(context.rendered).toContain('integration-db');
    expect(context.rendered).not.toContain('checkpoint');
  });
});

describe('file fingerprints', () => {
  it('reports a conflict when another Quest changed the same file', async () => {
    const a = await agent('Work on refresh tokens', 'claude-code');
    const b = await agent('Also work on refresh tokens', 'codex');

    await party.reportFingerprints({
      projectId: project.id,
      agentRunId: b.runId,
      workItemId: b.questId,
      files: [{ path: 'src/auth/refresh.ts', current_hash: 'sha256:bbb' }],
    });

    const result = await party.reportFingerprints({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      files: [{ path: 'src/auth/refresh.ts', base_hash: 'sha256:aaa', current_hash: 'sha256:ccc' }],
    });

    expect(result.recorded).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      path: 'src/auth/refresh.ts',
      your_base_hash: 'sha256:aaa',
      observed_hash: 'sha256:bbb',
    });
    // The conflict identifies the other Quest without exposing unrelated data.
    expect(result.conflicts[0]?.other_quest_title).toBe('Also work on refresh tokens');
  });

  it('reports no conflict when the hashes agree', async () => {
    const a = await agent('Work on refresh tokens', 'claude-code');
    const b = await agent('Other work', 'codex');

    await party.reportFingerprints({
      projectId: project.id,
      agentRunId: b.runId,
      workItemId: b.questId,
      files: [{ path: 'src/auth/refresh.ts', current_hash: 'sha256:aaa' }],
    });
    const result = await party.reportFingerprints({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      files: [{ path: 'src/auth/refresh.ts', base_hash: 'sha256:aaa' }],
    });
    expect(result.conflicts).toEqual([]);
  });
});

describe('party mode off', () => {
  it('leaves Quest and Lore untouched and reports itself disabled', async () => {
    // Acceptance criterion 16.
    const disabled = buildParty('off');
    expect(disabled.enabled).toBe(false);

    const started = await sessions.start({ project, client: 'claude-code' });
    const activated = await sessions.activate({
      sessionId: started.session.id,
      project,
      task: 'Add CSV report export',
    });
    expect(activated.quest).not.toBeNull();

    const checkpoint = await quests.createCheckpoint({
      sessionId: started.session.id,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'still works without Party',
      workState: {
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
    expect(checkpoint.questRevision).toBe(1);

    const context = await disabled.contextFor({
      projectId: project.id,
      sessionId: started.session.id,
      workItemId: activated.quest!.id,
    });
    expect(context.rendered).toBe('');
    expect(context.data).toEqual({ mode: 'off' });
  });

  it('records but does not enforce a claim when Party is off', async () => {
    const disabled = buildParty('off');
    const a = await agent('Add token-family migration', 'claude-code');
    const b = await agent('Add report tables', 'codex');

    await disabled.acquireClaim({
      projectId: project.id,
      agentRunId: a.runId,
      workItemId: a.questId,
      resourceType: 'migration_sequence',
      resourceKey: 'db/migrations',
      mode: 'exclusive',
    });

    // Nothing is enforced, but the attempt is still visible and warned about.
    const second = await disabled.acquireClaim({
      projectId: project.id,
      agentRunId: b.runId,
      workItemId: b.questId,
      resourceType: 'migration_sequence',
      resourceKey: 'file-that-differs',
      mode: 'exclusive',
    });
    expect(second.warnings.join(' ')).toContain('PARTY_MODE=off');
  });
});
