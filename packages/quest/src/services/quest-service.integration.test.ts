import type { WorkState } from '@saga/contracts';
import type { Project } from '@saga/core';
import { PgOutboxRepository, PgProjectRepository, ProjectService } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { JobService, PgJobRepository, PgSystemEventRepository } from '@saga/shrine';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, truncateAll } from '../../../../testing/harness.js';
import { QuestRepository } from '../repositories/quest-repository.js';
import { QuestService } from './quest-service.js';
import { SessionService } from './session-service.js';

let pool: SagaPool;
let quests: QuestService;
let sessions: SessionService;
let projects: ProjectService;
let project: Project;

const repo = new QuestRepository();

function workState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    goal: 'Add CSV report export',
    completed: [],
    in_progress: [],
    next_steps: [],
    blockers: [],
    decisions: [],
    changed_files: [],
    commands: [],
    tests: [],
    ...overrides,
  };
}

beforeEach(async () => {
  if (pool === undefined) {
    pool = createTestPool('saga-quest-test');
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
    quests = new QuestService({ pool, quests: repo, projects: projectRepo, outbox, jobs });
    sessions = new SessionService({
      pool,
      quests: repo,
      questService: quests,
      projects: projectRepo,
      outbox,
      party: {},
      abandonAfterMinutes: 180,
    });
  }
  await truncateAll(pool);
  project = await projects.create({ name: 'Quest Test Project' });
});

afterAll(async () => {
  await pool?.end();
});

async function startAndActivate(task: string, client = 'claude-code') {
  const started = await sessions.start({ project, client });
  const activated = await sessions.activate({
    sessionId: started.session.id,
    project,
    task,
  });
  return { sessionId: started.session.id, ...activated };
}

describe('two-phase session startup', () => {
  it('opens a session with no Quest and no activation mode', async () => {
    // Acceptance criterion 9: a new session must not automatically inherit a handoff.
    const started = await sessions.start({ project, client: 'claude-code' });
    expect(started.session.state).toBe('awaiting_task');
    expect(started.session.workItemId).toBeNull();
    expect(started.session.activationMode).toBeNull();
    expect(started.session.startedMemoryRevision).toBe(project.memoryRevision);
  });

  it('offers open Quests as suggestions without attaching one', async () => {
    await startAndActivate('Add CSV report export');
    const started = await sessions.start({ project, client: 'codex' });
    expect(started.openQuests.map((quest) => quest.title)).toEqual(['Add CSV report export']);
    expect(started.session.workItemId).toBeNull();
  });

  it('creates a Quest on the first task and moves it to in_progress', async () => {
    const result = await startAndActivate('Add CSV report export');
    expect(result.mode).toBe('new_work');
    expect(result.quest?.title).toBe('Add CSV report export');
    expect(result.quest?.status).toBe('in_progress');
    expect(result.quest?.revision).toBe(0);
  });

  it('does not create a Quest for an inquiry', async () => {
    // Acceptance criterion 11.
    const result = await startAndActivate('What does the outbox delivery worker do?');
    expect(result.mode).toBe('inquiry');
    expect(result.quest).toBeNull();
    expect(result.session.workItemId).toBeNull();

    const page = await quests.list({ projectId: project.id, limit: 50 });
    expect(page.items).toHaveLength(0);
  });

  it('promotes an inquiry session to real work', async () => {
    const started = await sessions.start({ project, client: 'claude-code' });
    await sessions.activate({ sessionId: started.session.id, project, task: 'Explain the worker' });

    const promoted = await sessions.promote({
      sessionId: started.session.id,
      project,
      mode: 'new_work',
      task: 'Add retry metrics to the worker',
    });
    expect(promoted.mode).toBe('new_work');
    expect(promoted.quest).not.toBeNull();
    expect(promoted.session.workItemId).toBe(promoted.quest!.id);
  });

  it('refuses to promote a session that already owns a Quest', async () => {
    const result = await startAndActivate('Add CSV report export');
    await expect(
      sessions.promote({ sessionId: result.sessionId, project, mode: 'new_work' }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_INVALID' });
  });
});

describe('checkpoints', () => {
  it('appends a checkpoint and advances the revision exactly once', async () => {
    const { sessionId, quest } = await startAndActivate('Add CSV report export');

    const first = await quests.createCheckpoint({
      sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'Implemented the generator',
      workState: workState({ completed: ['CSV serialization'] }),
    });
    expect(first.questRevision).toBe(1);
    expect(first.checkpoint.sequence).toBe(1);

    const second = await quests.createCheckpoint({
      sessionId,
      expectedQuestRevision: 1,
      kind: 'automatic',
      summary: 'Wired the endpoint',
      workState: workState(),
    });
    expect(second.questRevision).toBe(2);
    expect(second.checkpoint.sequence).toBe(2);

    const refreshed = await quests.get(quest!.id);
    expect(refreshed.revision).toBe(2);
    expect(refreshed.latestCheckpointId).toBe(second.checkpoint.id);
  });

  it('rejects a stale expected revision with the latest revision attached', async () => {
    // Acceptance criterion 12.
    const { sessionId } = await startAndActivate('Add CSV report export');
    await quests.createCheckpoint({
      sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'first',
      workState: workState(),
    });

    await expect(
      quests.createCheckpoint({
        sessionId,
        expectedQuestRevision: 0,
        kind: 'automatic',
        summary: 'stale',
        workState: workState(),
      }),
    ).rejects.toMatchObject({
      code: 'QUEST_REVISION_CONFLICT',
      details: { expected_revision: 0, latest_revision: 1 },
    });
  });

  it('lets exactly one of two concurrent checkpoints win', async () => {
    const { sessionId, quest } = await startAndActivate('Add CSV report export');

    const results = await Promise.allSettled([
      quests.createCheckpoint({
        sessionId,
        expectedQuestRevision: 0,
        kind: 'automatic',
        summary: 'A',
        workState: workState(),
      }),
      quests.createCheckpoint({
        sessionId,
        expectedQuestRevision: 0,
        kind: 'automatic',
        summary: 'B',
        workState: workState(),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'QUEST_REVISION_CONFLICT' });

    // Exactly one checkpoint and one revision bump survived.
    const checkpoints = await quests.listCheckpoints(quest!.id);
    expect(checkpoints).toHaveLength(1);
    expect((await quests.get(quest!.id)).revision).toBe(1);
  });

  it('keeps two sessions on the same Quest from colliding on sequence numbers', async () => {
    const first = await startAndActivate('Add CSV report export');
    const secondSession = await sessions.start({ project, client: 'codex' });
    await sessions.activate({
      sessionId: secondSession.session.id,
      project,
      task: 'Continue the CSV report export work',
      requestedQuestId: first.quest!.id,
    });

    await quests.createCheckpoint({
      sessionId: first.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'from session one',
      workState: workState(),
    });
    const other = await quests.createCheckpoint({
      sessionId: secondSession.session.id,
      expectedQuestRevision: 1,
      kind: 'automatic',
      summary: 'from session two',
      workState: workState(),
    });

    // Sequence is per session, so both are 1; the Quest revision is the global ordering.
    expect(other.checkpoint.sequence).toBe(1);
    expect(other.questRevision).toBe(2);
  });

  it('refuses a checkpoint from a session with no Quest', async () => {
    const started = await sessions.start({ project, client: 'claude-code' });
    await expect(
      quests.createCheckpoint({
        sessionId: started.session.id,
        expectedQuestRevision: 0,
        kind: 'automatic',
        summary: 'nope',
        workState: workState(),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_INVALID' });
  });

  it('emits the checkpoint event in the same transaction', async () => {
    const { sessionId } = await startAndActivate('Add CSV report export');
    await quests.createCheckpoint({
      sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'milestone',
      workState: workState(),
    });
    const events = await pool.query<{ topic: string }>(
      `SELECT topic FROM core.outbox_events WHERE topic = 'quest.checkpoint_created'`,
    );
    expect(events.rows).toHaveLength(1);
  });
});

describe('handoff and continuation', () => {
  it('ends a session with a final handoff and resumes from it', async () => {
    // Acceptance criterion 10.
    const first = await startAndActivate('Add CSV report export');
    await quests.createCheckpoint({
      sessionId: first.sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'generator done',
      workState: workState({ completed: ['CSV serialization'] }),
    });

    const ended = await sessions.end({
      sessionId: first.sessionId,
      handoff: {
        expectedQuestRevision: 1,
        summary: 'Stopping; the endpoint is not wired yet',
        workState: workState({
          next_steps: ['Wire the endpoint'],
          blockers: [{ description: 'No streaming interface', suggested_action: 'Add one' }],
        }),
      },
    });
    expect(ended.session.state).toBe('completed');
    expect(ended.handoff?.kind).toBe('final_handoff');

    const continuation = await quests.continuation(first.quest!.id, 2_500);
    expect(continuation?.recovered_from_interrupted_session).toBe(false);
    expect(continuation?.next_steps).toEqual(['Wire the endpoint']);
    expect(continuation?.rendered).toContain('Wire the endpoint');
    expect(continuation?.rendered).toContain('No streaming interface');
  });

  it('recovers continuation from the latest checkpoint of an interrupted session', async () => {
    // Acceptance criterion 13.
    const first = await startAndActivate('Add CSV report export');
    await quests.createCheckpoint({
      sessionId: first.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'partial progress before the crash',
      workState: workState({ next_steps: ['Finish the generator'] }),
    });

    // No clean end: the process simply stopped.
    const continuation = await quests.continuation(first.quest!.id, 2_500);
    expect(continuation?.recovered_from_interrupted_session).toBe(true);
    expect(continuation?.summary).toBe('partial progress before the crash');
    expect(continuation?.rendered).toContain('Recovered from an interrupted session');
  });

  it('prefers a checkpoint written after the handoff', async () => {
    const first = await startAndActivate('Add CSV report export');
    await sessions.end({
      sessionId: first.sessionId,
      handoff: {
        expectedQuestRevision: 0,
        summary: 'handoff',
        workState: workState({ next_steps: ['old step'] }),
      },
    });

    const second = await sessions.start({ project, client: 'codex' });
    await sessions.activate({
      sessionId: second.session.id,
      project,
      task: 'Continue the CSV report export work',
      requestedQuestId: first.quest!.id,
    });
    await quests.createCheckpoint({
      sessionId: second.session.id,
      expectedQuestRevision: 1,
      kind: 'automatic',
      summary: 'newer work',
      workState: workState({ next_steps: ['new step'] }),
    });

    const continuation = await quests.continuation(first.quest!.id, 2_500);
    expect(continuation?.summary).toBe('newer work');
    expect(continuation?.recovered_from_interrupted_session).toBe(true);
  });

  it('requires a handoff when the session owns a Quest', async () => {
    const first = await startAndActivate('Add CSV report export');
    await expect(sessions.end({ sessionId: first.sessionId })).rejects.toMatchObject({
      code: 'CHECKPOINT_INVALID',
    });
  });

  it('lets an inquiry session end without a handoff', async () => {
    const started = await sessions.start({ project, client: 'claude-code' });
    await sessions.activate({
      sessionId: started.session.id,
      project,
      task: 'What is the outbox?',
    });
    const ended = await sessions.end({ sessionId: started.session.id });
    expect(ended.session.state).toBe('completed');
    expect(ended.handoff).toBeNull();
  });

  it('is idempotent when ending twice', async () => {
    const started = await sessions.start({ project, client: 'claude-code' });
    await sessions.activate({ sessionId: started.session.id, project, task: 'What is this?' });
    await sessions.end({ sessionId: started.session.id });
    const again = await sessions.end({ sessionId: started.session.id });
    expect(again.session.state).toBe('completed');
  });
});

describe('resume behaviour', () => {
  it('does not load an unrelated Quest handoff into a new session', async () => {
    // The defining scenario: a new task must not inherit a stranger's context.
    const first = await startAndActivate('Add CSV report export');
    await sessions.end({
      sessionId: first.sessionId,
      handoff: {
        expectedQuestRevision: 0,
        summary: 'handoff for CSV work',
        workState: workState({ next_steps: ['Wire the endpoint'] }),
      },
    });

    const unrelated = await startAndActivate('Fix the login page layout');
    expect(unrelated.mode).toBe('new_work');
    expect(unrelated.quest?.id).not.toBe(first.quest?.id);
    expect(unrelated.quest?.title).toBe('Fix the login page layout');
  });

  it('resumes the same Quest when the caller asks for it explicitly', async () => {
    const first = await startAndActivate('Add CSV report export');
    await sessions.end({
      sessionId: first.sessionId,
      handoff: {
        expectedQuestRevision: 0,
        summary: 'handoff',
        workState: workState({ next_steps: ['Wire the endpoint'] }),
      },
    });

    const second = await sessions.start({ project, client: 'codex' });
    const resumed = await sessions.activate({
      sessionId: second.session.id,
      project,
      task: 'Continue the CSV report export work',
      requestedQuestId: first.quest!.id,
    });
    expect(resumed.mode).toBe('resume_work');
    expect(resumed.quest?.id).toBe(first.quest?.id);
  });

  it('merges newly declared scope into a resumed Quest', async () => {
    const first = await startAndActivate('Add CSV report export');
    const second = await sessions.start({ project, client: 'codex' });
    const resumed = await sessions.activate({
      sessionId: second.session.id,
      project,
      task: 'Continue',
      requestedQuestId: first.quest!.id,
      scope: { files: ['services/api/src/reports/csv.ts'] },
    });
    expect(resumed.quest?.scope.files).toContain('services/api/src/reports/csv.ts');
  });
});

describe('questlines', () => {
  it('projects the parent status from its children', async () => {
    const parent = await quests.create({ project, title: 'Improve authentication security' });
    const a = await quests.create({
      project,
      title: 'Add token-family schema',
      parentWorkItemId: parent.id,
    });
    const b = await quests.create({
      project,
      title: 'Implement token rotation',
      parentWorkItemId: parent.id,
    });

    await quests.update(a.id, { status: 'in_progress' });
    expect((await quests.get(parent.id)).status).toBe('in_progress');

    await quests.update(a.id, { status: 'completed' });
    await quests.update(b.id, { status: 'blocked' });
    expect((await quests.get(parent.id)).status).toBe('blocked');

    await quests.update(b.id, { status: 'completed' });
    expect((await quests.get(parent.id)).status).toBe('completed');
  });

  it('does not overwrite a manually set parent status', async () => {
    const parent = await quests.create({ project, title: 'Questline' });
    const child = await quests.create({ project, title: 'Child', parentWorkItemId: parent.id });

    await quests.update(parent.id, { status: 'waiting' });
    await quests.update(child.id, { status: 'in_progress' });

    expect((await quests.get(parent.id)).status).toBe('waiting');
  });

  it('propagates a projection up a multi-level Questline', async () => {
    const grandparent = await quests.create({ project, title: 'Epic' });
    const parent = await quests.create({
      project,
      title: 'Questline',
      parentWorkItemId: grandparent.id,
    });
    const child = await quests.create({ project, title: 'Child', parentWorkItemId: parent.id });

    await quests.update(child.id, { status: 'in_progress' });
    expect((await quests.get(parent.id)).status).toBe('in_progress');
    expect((await quests.get(grandparent.id)).status).toBe('in_progress');
  });

  it('rejects a parent from another project', async () => {
    const other = await projects.create({ name: 'Other Quest Project' });
    const foreign = await quests.create({ project: other, title: 'Foreign parent' });
    await expect(
      quests.create({ project, title: 'Child', parentWorkItemId: foreign.id }),
    ).rejects.toMatchObject({ code: 'QUEST_PARENT_INVALID' });
  });

  it('rejects a parent cycle', async () => {
    const a = await quests.create({ project, title: 'A' });
    const b = await quests.create({ project, title: 'B', parentWorkItemId: a.id });
    await expect(quests.update(a.id, { parentWorkItemId: b.id })).rejects.toMatchObject({
      code: 'QUEST_PARENT_INVALID',
    });
  });
});

describe('dependencies', () => {
  it('records a dependency with the target title', async () => {
    const a = await quests.create({ project, title: 'Add schema' });
    const b = await quests.create({ project, title: 'Implement rotation' });
    const dependencies = await quests.addDependency(b.id, a.id, 'must_complete_before');
    expect(dependencies[0]).toMatchObject({
      dependsOnWorkItemId: a.id,
      dependsOnTitle: 'Add schema',
      dependencyType: 'must_complete_before',
    });
  });

  it('rejects a self-dependency, a cross-project dependency and a cycle', async () => {
    const a = await quests.create({ project, title: 'A' });
    const b = await quests.create({ project, title: 'B' });
    const other = await projects.create({ name: 'Another Quest Project' });
    const foreign = await quests.create({ project: other, title: 'Foreign' });

    await expect(quests.addDependency(a.id, a.id, 'blocks')).rejects.toMatchObject({
      code: 'QUEST_DEPENDENCY_INVALID',
    });
    await expect(quests.addDependency(a.id, foreign.id, 'blocks')).rejects.toMatchObject({
      code: 'QUEST_DEPENDENCY_INVALID',
    });

    await quests.addDependency(a.id, b.id, 'blocks');
    await expect(quests.addDependency(b.id, a.id, 'blocks')).rejects.toMatchObject({
      code: 'QUEST_DEPENDENCY_INVALID',
    });
  });
});

describe('lifecycle', () => {
  it('refuses to archive a Quest that is still active', async () => {
    const quest = await quests.create({ project, title: 'Active work' });
    await expect(quests.archive(quest.id)).rejects.toMatchObject({ code: 'QUEST_STATE_INVALID' });
  });

  it('archives a completed Quest and reopens it explicitly', async () => {
    const quest = await quests.create({ project, title: 'Finished work' });
    await quests.update(quest.id, { status: 'completed' });
    const archived = await quests.archive(quest.id);
    expect(archived.archivedAt).not.toBeNull();

    const reopened = await quests.reopen(quest.id);
    expect(reopened.status).toBe('in_progress');
    expect(reopened.archivedAt).toBeNull();
  });

  it('rejects an impossible status transition', async () => {
    const quest = await quests.create({ project, title: 'Work' });
    await quests.update(quest.id, { status: 'completed' });
    await expect(quests.update(quest.id, { status: 'blocked' })).rejects.toMatchObject({
      code: 'QUEST_STATE_INVALID',
    });
  });
});

describe('embedding jobs', () => {
  it('enqueues an embedding job whose payload the worker handler understands', async () => {
    // Regression: Quest creation enqueued { work_item_id } while the embedding handler only
    // accepted { memory_version_id }, so every Quest embedding failed permanently and
    // semantic Quest matching could never work.
    const quest = await quests.create({ project, title: 'Add CSV report export' });
    const jobs = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM shrine.jobs WHERE job_type = 'embedding' AND entity_id = $1`,
      [quest.id],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.payload).toEqual({ work_item_id: quest.id });

    const { createEmbeddingHandler } = await import('../../../../apps/worker/src/handlers/lore.js');
    const { DeterministicFakeEmbeddingProvider, MemoryRepository } = await import('@saga/lore');
    const handler = createEmbeddingHandler({
      pool,
      memory: new MemoryRepository(),
      quests: repo,
      provider: new DeterministicFakeEmbeddingProvider(768),
    });

    const result = (await handler.handle({
      job: { payload: jobs.rows[0]!.payload } as never,
      logger: { debug: () => {} } as never,
      signal: new AbortController().signal,
      renewLease: async () => true,
    })) as { work_item_id: string };

    expect(result.work_item_id).toBe(quest.id);
    expect((await quests.get(quest.id)).embeddingState).toBe('ready');
  });
});

describe('session reaping', () => {
  it('abandons a session that stopped reporting', async () => {
    const started = await sessions.start({ project, client: 'claude-code' });
    await pool.query(
      `UPDATE quest.sessions SET last_seen_at = now() - interval '10 hours' WHERE id = $1`,
      [started.session.id],
    );

    const abandoned = await sessions.reapStaleSessions();
    expect(abandoned).toContain(started.session.id);
    expect((await sessions.get(started.session.id)).state).toBe('abandoned');
  });

  it('leaves a live session alone and preserves checkpoints of an abandoned one', async () => {
    const live = await sessions.start({ project, client: 'claude-code' });
    const stale = await startAndActivate('Add CSV report export');
    await quests.createCheckpoint({
      sessionId: stale.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'work before the crash',
      workState: workState(),
    });
    await pool.query(
      `UPDATE quest.sessions SET last_seen_at = now() - interval '10 hours' WHERE id = $1`,
      [stale.sessionId],
    );

    const abandoned = await sessions.reapStaleSessions();
    expect(abandoned).not.toContain(live.session.id);

    // The durable record survives: the Quest and its checkpoints are untouched.
    const checkpoints = await quests.listCheckpoints(stale.quest!.id);
    expect(checkpoints).toHaveLength(1);
    expect((await quests.get(stale.quest!.id)).revision).toBe(1);
  });
});

describe('the Quest plan', () => {
  it('numbers the declared steps from 1 and starts them all pending', async () => {
    const activated = await startAndActivate('Add CSV report export');
    const plan = await quests.setPlan(activated.quest!.id, [
      'Write the exporter',
      'Wire the route',
      'Document it',
    ]);

    expect(plan.steps.map((step) => [step.ordinal, step.title, step.status])).toEqual([
      [1, 'Write the exporter', 'pending'],
      [2, 'Wire the route', 'pending'],
      [3, 'Document it', 'pending'],
    ]);
    expect(plan.progress).toMatchObject({ total: 3, done: 0, remaining: 3, next_ordinal: 1 });
  });

  it('settles a step in the checkpoint that reports it, and records which one', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter', 'Wire the route']);

    const result = await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });

    const settled = result.plan!.steps[0]!;
    expect(settled.status).toBe('done');
    expect(settled.completed_by_checkpoint_id).toBe(result.checkpoint.id);
    expect(settled.completed_by_session_id).toBe(activated.sessionId);
    expect(settled.completed_at).not.toBeNull();
    expect(result.plan!.progress.next_ordinal).toBe(2);
    // One step of two: the Quest is still open.
    expect(result.questStatus).toBe('in_progress');
  });

  it('rejects a step number the plan does not have rather than ignoring it', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);

    await expect(
      quests.createCheckpoint({
        sessionId: activated.sessionId,
        expectedQuestRevision: 0,
        kind: 'automatic',
        summary: 'ticking off something that is not there',
        workState: workState(),
        stepUpdates: [{ ordinal: 4 }],
      }),
    ).rejects.toMatchObject({ code: 'QUEST_STEP_NOT_FOUND' });

    // The whole checkpoint rolled back with it: no half-written progress.
    expect(await quests.listCheckpoints(activated.quest!.id)).toHaveLength(0);
    expect((await quests.get(activated.quest!.id)).revision).toBe(0);
  });

  it('completes the Quest when the last step settles, even with next steps outstanding', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter', 'Wire the route']);
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });

    const result = await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 1,
      kind: 'milestone',
      summary: 'route wired',
      workState: workState({ next_steps: ['Consider a follow-up for XLSX too'] }),
      stepUpdates: [{ ordinal: 2 }],
    });

    expect(result.questStatus).toBe('completed');
    expect(result.questStatusHeld).toBeNull();
    const quest = await quests.get(activated.quest!.id);
    expect(quest.status).toBe('completed');
    expect(quest.completedAt).not.toBeNull();
  });

  it('does not complete a Quest whose plan was only skipped', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);

    const result = await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'turned out to be unnecessary',
      workState: workState(),
      stepUpdates: [{ ordinal: 1, status: 'skipped' }],
    });

    expect(result.questStatus).toBe('in_progress');
  });

  it('leaves a Quest with no plan exactly as it was before plans existed', async () => {
    const activated = await startAndActivate('Add CSV report export');
    const result = await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'final_handoff',
      summary: 'all finished, nothing outstanding',
      workState: workState(),
    });

    expect(result.plan).toBeNull();
    expect(result.questStatus).toBe('in_progress');
  });

  it('holds the completion on a manual project and says why', async () => {
    const manual = await projects.create({
      name: 'Manual Completion Project',
      questCompletionMode: 'manual',
    });
    const started = await sessions.start({ project: manual, client: 'claude-code' });
    const activated = await sessions.activate({
      sessionId: started.session.id,
      project: manual,
      task: 'Add CSV report export',
    });
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);

    const result = await quests.createCheckpoint({
      sessionId: started.session.id,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });

    expect(result.questStatus).toBe('in_progress');
    expect(result.questStatusHeld).toMatch(/manual/);
    expect((await quests.get(activated.quest!.id)).status).toBe('in_progress');
  });

  it('holds the completion while another session is still attached', async () => {
    const first = await startAndActivate('Add CSV report export');
    await quests.setPlan(first.quest!.id, ['Write the exporter']);

    // A second agent resumes the same Quest: one of them finishing its steps is not the work
    // being finished.
    const second = await sessions.start({ project, client: 'codex' });
    await sessions.activate({
      sessionId: second.session.id,
      project,
      task: 'Continue the CSV report export',
      modeHint: 'resume_work',
      requestedQuestId: first.quest!.id,
    });

    const result = await quests.createCheckpoint({
      sessionId: first.sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });

    expect(result.questStatus).toBe('in_progress');
    expect(result.questStatusHeld).toMatch(/another session/);
  });

  it('keeps a settled step when a re-declared plan appends to it', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter', 'Wire the route']);
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });

    const replanned = await quests.setPlan(activated.quest!.id, [
      'Write the exporter',
      'Wire the route',
      'Document it',
    ]);

    expect(replanned.steps.map((step) => step.status)).toEqual(['done', 'pending', 'pending']);
    expect(replanned.progress).toMatchObject({ total: 3, done: 1, next_ordinal: 2 });
  });

  it('resets a step the re-declared plan renamed', async () => {
    const activated = await startAndActivate('Add CSV report export');
    // Two steps, so settling the first leaves the Quest open and re-plannable.
    await quests.setPlan(activated.quest!.id, ['Write the exporter', 'Wire the route']);
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });

    const replanned = await quests.setPlan(activated.quest!.id, [
      'Write the exporter and the CLI',
      'Wire the route',
    ]);
    expect(replanned.steps[0]!.status).toBe('pending');
    expect(replanned.steps[0]!.completed_at).toBeNull();
    // The untouched step keeps its own status, which here is the pending it started with.
    expect(replanned.steps[1]!.title).toBe('Wire the route');
  });

  it('refuses a new plan for a Quest that has already closed', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });
    expect((await quests.get(activated.quest!.id)).status).toBe('completed');

    await expect(quests.setPlan(activated.quest!.id, ['Something else'])).rejects.toMatchObject({
      code: 'QUEST_STATE_INVALID',
    });
  });

  it('leads the continuation with the plan and the first unsettled step', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter', 'Wire the route']);
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'final_handoff',
      summary: 'exporter done, route still to do',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });

    const continuation = await quests.continuation(activated.quest!.id, 4_000);
    expect(continuation!.plan!.progress.next_ordinal).toBe(2);
    expect(continuation!.rendered).toContain('[x] 1. Write the exporter');
    expect(continuation!.rendered).toContain('[ ] 2. Wire the route');
    expect(continuation!.rendered).toContain('Resume at step 2');
  });
});

describe('the plan sweeper', () => {
  it('closes a Quest whose plan finished but whose session died before ending', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);

    // A second session is attached, so the checkpoint cannot close it — this is the crash shape:
    // steps settled, nobody left to declare the outcome.
    const other = await sessions.start({ project, client: 'codex' });
    await sessions.activate({
      sessionId: other.session.id,
      project,
      task: 'Continue the CSV report export',
      modeHint: 'resume_work',
      requestedQuestId: activated.quest!.id,
    });
    const held = await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });
    expect(held.questStatus).toBe('in_progress');

    // Both sessions go quiet and are reaped.
    await pool.query(`UPDATE quest.sessions SET last_seen_at = now() - interval '10 hours'`);
    await sessions.reapStaleSessions();

    const swept = await quests.sweepCompletedPlans();
    expect(swept.completed).toContain(activated.quest!.id);
    expect((await quests.get(activated.quest!.id)).status).toBe('completed');
  });

  it('leaves a Quest alone while a session is still attached to it', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);
    const other = await sessions.start({ project, client: 'codex' });
    await sessions.activate({
      sessionId: other.session.id,
      project,
      task: 'Continue the CSV report export',
      modeHint: 'resume_work',
      requestedQuestId: activated.quest!.id,
    });
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });

    expect((await quests.sweepCompletedPlans()).completed).toHaveLength(0);
    expect((await quests.get(activated.quest!.id)).status).toBe('in_progress');
  });

  it('never sweeps a Quest that declared no plan, however quiet it is', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'final_handoff',
      summary: 'all done as far as I know',
      workState: workState(),
    });
    await pool.query(`UPDATE quest.sessions SET last_seen_at = now() - interval '10 hours'`);
    await sessions.reapStaleSessions();

    expect((await quests.sweepCompletedPlans()).completed).toHaveLength(0);
    expect((await quests.get(activated.quest!.id)).status).toBe('in_progress');
  });

  it('never sweeps a Quest on a manual project', async () => {
    const manual = await projects.create({
      name: 'Manual Sweep Project',
      questCompletionMode: 'manual',
    });
    const started = await sessions.start({ project: manual, client: 'claude-code' });
    const activated = await sessions.activate({
      sessionId: started.session.id,
      project: manual,
      task: 'Add CSV report export',
    });
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);
    await quests.createCheckpoint({
      sessionId: started.session.id,
      expectedQuestRevision: 0,
      kind: 'automatic',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });
    await pool.query(`UPDATE quest.sessions SET last_seen_at = now() - interval '10 hours'`);
    await sessions.reapStaleSessions();

    expect((await quests.sweepCompletedPlans()).completed).toHaveLength(0);
    expect((await quests.get(activated.quest!.id)).status).toBe('in_progress');
  });
});

describe('re-activating a session whose Quest has closed', () => {
  it('starts a new Quest for a new request in the same session', async () => {
    const first = await startAndActivate('Add CSV report export');
    await quests.setPlan(first.quest!.id, ['Write the exporter']);
    const completed = await quests.createCheckpoint({
      sessionId: first.sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });
    expect(completed.questStatus).toBe('completed');

    // The user asks for something else without opening a new session — the common shape now
    // that a finished plan closes a Quest mid-session.
    const second = await sessions.activate({
      sessionId: first.sessionId,
      project,
      task: 'Add a Prometheus endpoint to the worker',
    });

    expect(second.mode).toBe('new_work');
    expect(second.quest!.id).not.toBe(first.quest!.id);
    expect(second.quest!.status).toBe('in_progress');
    // The session moved across; the finished Quest keeps its own history.
    expect(second.session.workItemId).toBe(second.quest!.id);
    expect((await quests.get(first.quest!.id)).status).toBe('completed');
    expect(await quests.listCheckpoints(first.quest!.id)).toHaveLength(1);
  });

  it('checkpoints the new Quest from its own revision, leaving the closed one alone', async () => {
    const first = await startAndActivate('Add CSV report export');
    await quests.setPlan(first.quest!.id, ['Write the exporter']);
    await quests.createCheckpoint({
      sessionId: first.sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });

    const second = await sessions.activate({
      sessionId: first.sessionId,
      project,
      task: 'Add a Prometheus endpoint to the worker',
    });
    await quests.createCheckpoint({
      sessionId: first.sessionId,
      expectedQuestRevision: second.quest!.revision,
      kind: 'automatic',
      summary: 'endpoint scaffolded',
      workState: workState({ goal: 'Add a Prometheus endpoint' }),
    });

    expect(await quests.listCheckpoints(second.quest!.id)).toHaveLength(1);
    expect(await quests.listCheckpoints(first.quest!.id)).toHaveLength(1);
  });

  it('still refuses to rebind a session whose Quest is open', async () => {
    // The original guard: rebinding live work would strand it and move later checkpoints onto
    // a different Quest.
    const first = await startAndActivate('Add CSV report export');
    await expect(
      sessions.activate({
        sessionId: first.sessionId,
        project,
        task: 'Add a Prometheus endpoint to the worker',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_INVALID' });
  });

  it('re-activates after a cancelled Quest too', async () => {
    const first = await startAndActivate('Add CSV report export');
    await quests.update(first.quest!.id, { status: 'cancelled' });

    const second = await sessions.activate({
      sessionId: first.sessionId,
      project,
      task: 'Add a Prometheus endpoint to the worker',
    });
    expect(second.quest!.id).not.toBe(first.quest!.id);
  });
});

describe('reopening a Quest', () => {
  it('brings a plan-completed Quest back to in_progress with its plan intact', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });
    expect((await quests.get(activated.quest!.id)).status).toBe('completed');

    const reopened = await quests.reopen(activated.quest!.id);
    expect(reopened.status).toBe('in_progress');
    expect(reopened.completedAt).toBeNull();

    // The settled steps survive, so the agent can see what was already done.
    const plan = await quests.getPlan(activated.quest!.id);
    expect(plan.progress).toMatchObject({ total: 1, done: 1 });
  });

  it('lets a reopened Quest take a new plan and complete again', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });
    await quests.reopen(activated.quest!.id);

    // Appending the step that was actually missing: the first is carried over as done.
    const replanned = await quests.setPlan(activated.quest!.id, [
      'Write the exporter',
      'Handle the empty-result case',
    ]);
    expect(replanned.steps.map((step) => step.status)).toEqual(['done', 'pending']);

    const quest = await quests.get(activated.quest!.id);
    const finished = await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: quest.revision,
      kind: 'final_handoff',
      summary: 'empty results handled',
      workState: workState(),
      stepUpdates: [{ ordinal: 2 }],
    });
    expect(finished.questStatus).toBe('completed');
  });

  it('will not reopen a Quest that was never closed', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await expect(quests.reopen(activated.quest!.id)).rejects.toMatchObject({
      code: 'QUEST_STATE_INVALID',
    });
  });

  it('does not let the sweeper close a reopened Quest again while work is outstanding', async () => {
    const activated = await startAndActivate('Add CSV report export');
    await quests.setPlan(activated.quest!.id, ['Write the exporter']);
    await quests.createCheckpoint({
      sessionId: activated.sessionId,
      expectedQuestRevision: 0,
      kind: 'milestone',
      summary: 'exporter done',
      workState: workState(),
      stepUpdates: [{ ordinal: 1 }],
    });
    await quests.reopen(activated.quest!.id);
    await quests.setPlan(activated.quest!.id, [
      'Write the exporter',
      'Handle the empty-result case',
    ]);
    await pool.query(`UPDATE quest.sessions SET last_seen_at = now() - interval '10 hours'`);
    await sessions.reapStaleSessions();

    // Step 2 is unsettled, so the plan no longer says the Quest is finished.
    expect((await quests.sweepCompletedPlans()).completed).toHaveLength(0);
    expect((await quests.get(activated.quest!.id)).status).toBe('in_progress');
  });
});
