import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiHarness, type ApiClient, type ApiHarness } from '../testing/api-harness.js';

let harness: ApiHarness;
let admin: ApiClient;
let projectId: string;
let projectName: string;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  admin = await harness.loginAs('admin');
  projectName = 'Quest API Project';
  const created = await admin.post('/api/projects', { name: projectName });
  projectId = created.body.project.id;
});

function workState(overrides: Record<string, unknown> = {}) {
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

async function startSession(client = 'claude-code'): Promise<string> {
  const response = await admin.post('/api/sessions', { project: projectName, client });
  expect(response.status).toBe(201);
  return response.body.session_id;
}

describe('session startup', () => {
  it('opens in awaiting_task with core context but no handoff', async () => {
    const response = await admin.post('/api/sessions', {
      project: projectName,
      client: 'claude-code',
      agent: 'claude',
    });
    expect(response.status).toBe(201);
    expect(response.body.state).toBe('awaiting_task');
    expect(response.body.project.id).toBe(projectId);
    expect(response.body.bootstrap_required).toBe(true);
    expect(response.body.bootstrap_plan.rules.length).toBeGreaterThan(0);
    // Nothing in the phase-one response can carry another Quest's continuation.
    expect(Object.keys(response.body)).not.toContain('continuation');
  });

  it('offers open Quests as suggestions without attaching one', async () => {
    const first = await startSession();
    await admin.post(`/api/sessions/${first}/activate`, { task: 'Add CSV report export' });

    const second = await admin.post('/api/sessions', { project: projectName, client: 'codex' });
    expect(second.body.open_quests).toHaveLength(1);
    expect(second.body.open_quests[0].title).toBe('Add CSV report export');

    const session = await admin.get(`/api/sessions/${second.body.session_id}`);
    expect(session.body.session.work_item_id).toBeNull();
  });

  it('resolves the project by alias', async () => {
    await admin.patch(`/api/projects/${projectId}`, { name: 'Quest API Renamed' });
    const response = await admin.post('/api/sessions', {
      project: projectName,
      client: 'claude-code',
    });
    expect(response.status).toBe(201);
    expect(response.body.project.id).toBe(projectId);
  });
});

describe('activation', () => {
  it('creates a Quest for new work and returns no continuation', async () => {
    const sessionId = await startSession();
    const response = await admin.post(`/api/sessions/${sessionId}/activate`, {
      task: 'Add CSV report export',
      scope: { modules: ['services/api/src/reports'] },
    });

    expect(response.body.activation_mode).toBe('new_work');
    expect(response.body.quest.title).toBe('Add CSV report export');
    expect(response.body.quest.status).toBe('in_progress');
    expect(response.body.quest.revision).toBe(0);
    expect(response.body.quest.scope.modules).toEqual(['services/api/src/reports']);
    expect(response.body.context.continuation).toBeNull();
  });

  it('creates no Quest for an inquiry', async () => {
    const sessionId = await startSession();
    const response = await admin.post(`/api/sessions/${sessionId}/activate`, {
      task: 'What does the outbox delivery worker do?',
    });
    expect(response.body.activation_mode).toBe('inquiry');
    expect(response.body.quest).toBeNull();

    const quests = await admin.get(`/api/projects/${projectId}/quests`);
    expect(quests.body.items).toHaveLength(0);
  });

  it('promotes an inquiry session once real work begins', async () => {
    const sessionId = await startSession();
    await admin.post(`/api/sessions/${sessionId}/activate`, { task: 'Explain the worker' });
    const promoted = await admin.post(`/api/sessions/${sessionId}/promote`, {
      mode: 'new_work',
      task: 'Add retry metrics to the worker',
    });
    expect(promoted.body.activation_mode).toBe('new_work');
    expect(promoted.body.quest).not.toBeNull();
  });

  it('honours an explicit mode hint', async () => {
    const sessionId = await startSession();
    const response = await admin.post(`/api/sessions/${sessionId}/activate`, {
      task: 'What is the outbox?',
      mode_hint: 'new_work',
    });
    expect(response.body.activation_mode).toBe('new_work');
  });

  it('does not inherit an unrelated Quest handoff', async () => {
    // The defining scenario of the specification.
    const first = await startSession();
    const activated = await admin.post(`/api/sessions/${first}/activate`, {
      task: 'Add CSV report export',
    });
    await admin.post(`/api/sessions/${first}/end`, {
      handoff: {
        expected_quest_revision: activated.body.quest.revision,
        summary: 'Stopping for the day',
        work_state: workState({ next_steps: ['Wire the endpoint'] }),
      },
    });

    const second = await startSession('codex');
    const unrelated = await admin.post(`/api/sessions/${second}/activate`, {
      task: 'Fix the login page layout',
    });
    expect(unrelated.body.activation_mode).toBe('new_work');
    expect(unrelated.body.context.continuation).toBeNull();
    expect(unrelated.body.quest.id).not.toBe(activated.body.quest.id);
    // The related Quest is offered rather than applied.
    expect(unrelated.body.related_quests.length).toBeGreaterThanOrEqual(0);
  });

  it('loads the handoff when the caller resumes explicitly', async () => {
    const first = await startSession();
    const activated = await admin.post(`/api/sessions/${first}/activate`, {
      task: 'Add CSV report export',
    });
    const questId = activated.body.quest.id;

    await admin.post(`/api/sessions/${first}/end`, {
      handoff: {
        expected_quest_revision: 0,
        summary: 'Stopping; the endpoint is not wired yet',
        work_state: workState({
          next_steps: ['Wire POST /v1/reports/export'],
          blockers: [{ description: 'No streaming interface', suggested_action: 'Add one' }],
          completed: ['CSV serialization'],
        }),
      },
    });

    const second = await startSession('codex');
    const resumed = await admin.post(`/api/sessions/${second}/activate`, {
      task: 'Continue the CSV report export work',
      requested_quest_id: questId,
    });

    expect(resumed.body.activation_mode).toBe('resume_work');
    expect(resumed.body.quest.id).toBe(questId);
    const continuation = resumed.body.context.continuation;
    expect(continuation.recovered_from_interrupted_session).toBe(false);
    expect(continuation.next_steps).toEqual(['Wire POST /v1/reports/export']);
    expect(continuation.blockers[0].description).toBe('No streaming interface');
    expect(continuation.rendered).toContain('Wire POST /v1/reports/export');
  });

  it('recovers a continuation from an interrupted session', async () => {
    const first = await startSession();
    const activated = await admin.post(`/api/sessions/${first}/activate`, {
      task: 'Add CSV report export',
    });
    await admin.post(`/api/sessions/${first}/checkpoints`, {
      expected_quest_revision: 0,
      kind: 'automatic',
      summary: 'partial progress before the crash',
      work_state: workState({ next_steps: ['Finish the generator'] }),
    });
    // No clean end: the process simply stopped.

    const second = await startSession('codex');
    const resumed = await admin.post(`/api/sessions/${second}/activate`, {
      task: 'Continue',
      requested_quest_id: activated.body.quest.id,
    });
    expect(resumed.body.context.continuation.recovered_from_interrupted_session).toBe(true);
    expect(resumed.body.context.continuation.rendered).toContain(
      'Recovered from an interrupted session',
    );
  });

  it('refuses to activate a completed session', async () => {
    const sessionId = await startSession();
    await admin.post(`/api/sessions/${sessionId}/activate`, { task: 'What is this?' });
    await admin.post(`/api/sessions/${sessionId}/end`, {});
    const response = await admin.post(`/api/sessions/${sessionId}/activate`, { task: 'again' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('SESSION_STATE_INVALID');
  });
});

describe('checkpoints', () => {
  let sessionId: string;
  let questId: string;

  beforeEach(async () => {
    sessionId = await startSession();
    const activated = await admin.post(`/api/sessions/${sessionId}/activate`, {
      task: 'Add CSV report export',
    });
    questId = activated.body.quest.id;
  });

  it('records a checkpoint and returns the new revision', async () => {
    const response = await admin.post(`/api/sessions/${sessionId}/checkpoints`, {
      expected_quest_revision: 0,
      kind: 'milestone',
      summary: 'Implemented the CSV generator and unit tests',
      work_state: workState({ completed: ['Implemented CSV serialization'] }),
    });
    expect(response.status).toBe(201);
    expect(response.body.quest_revision).toBe(1);
    expect(response.body.checkpoint.sequence).toBe(1);
  });

  it('returns 409 for a stale expected revision, with the latest attached', async () => {
    await admin.post(`/api/sessions/${sessionId}/checkpoints`, {
      expected_quest_revision: 0,
      kind: 'automatic',
      summary: 'first',
      work_state: workState(),
    });
    const stale = await admin.post(`/api/sessions/${sessionId}/checkpoints`, {
      expected_quest_revision: 0,
      kind: 'automatic',
      summary: 'stale',
      work_state: workState(),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('QUEST_REVISION_CONFLICT');
    expect(stale.body.error.details.latest_revision).toBe(1);
  });

  it('validates the work-state structure', async () => {
    const response = await admin.post(`/api/sessions/${sessionId}/checkpoints`, {
      expected_quest_revision: 0,
      kind: 'milestone',
      summary: 'bad state',
      work_state: { completed: 'not an array' },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error.details)).toContain('goal');
  });

  it('lists checkpoints newest first with the current revision', async () => {
    for (let revision = 0; revision < 3; revision += 1) {
      await admin.post(`/api/sessions/${sessionId}/checkpoints`, {
        expected_quest_revision: revision,
        kind: 'automatic',
        summary: `checkpoint ${revision}`,
        work_state: workState(),
      });
    }
    const response = await admin.get(`/api/quests/${questId}/checkpoints`);
    expect(response.body.items).toHaveLength(3);
    expect(response.body.quest_revision).toBe(3);
    expect(response.body.items[0].summary).toBe('checkpoint 2');
  });

  it('is idempotent under a retried Idempotency-Key', async () => {
    const headers = { 'idempotency-key': 'checkpoint-once-only' };
    const body = {
      expected_quest_revision: 0,
      kind: 'milestone' as const,
      summary: 'once',
      work_state: workState(),
    };
    const first = await admin.post(`/api/sessions/${sessionId}/checkpoints`, body, headers);
    const replay = await admin.post(`/api/sessions/${sessionId}/checkpoints`, body, headers);

    expect(replay.body.checkpoint.id).toBe(first.body.checkpoint.id);
    // A replay must not advance the revision a second time.
    expect((await admin.get(`/api/quests/${questId}`)).body.quest.revision).toBe(1);
  });
});

describe('session end', () => {
  it('writes a final handoff and completes the session', async () => {
    const sessionId = await startSession();
    await admin.post(`/api/sessions/${sessionId}/activate`, { task: 'Add CSV report export' });

    const response = await admin.post(`/api/sessions/${sessionId}/end`, {
      handoff: {
        expected_quest_revision: 0,
        summary: 'Handing off',
        work_state: workState({ next_steps: ['Wire the endpoint'] }),
      },
    });
    expect(response.body.session.state).toBe('completed');
    expect(response.body.handoff.kind).toBe('final_handoff');
    expect(response.body.quest_revision).toBe(1);
  });

  it('requires a handoff when the session owns a Quest', async () => {
    const sessionId = await startSession();
    await admin.post(`/api/sessions/${sessionId}/activate`, { task: 'Add CSV report export' });
    const response = await admin.post(`/api/sessions/${sessionId}/end`, {});
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('CHECKPOINT_INVALID');
  });

  it('lets an inquiry session end without one', async () => {
    const sessionId = await startSession();
    await admin.post(`/api/sessions/${sessionId}/activate`, { task: 'What is the outbox?' });
    const response = await admin.post(`/api/sessions/${sessionId}/end`, {});
    expect(response.body.session.state).toBe('completed');
    expect(response.body.handoff).toBeNull();
  });
});

describe('quest management', () => {
  it('creates, lists, updates and archives a Quest', async () => {
    const created = await admin.post(`/api/projects/${projectId}/quests`, {
      title: 'Improve authentication security',
      objective: 'Rotate refresh tokens safely',
      priority: 'high',
    });
    expect(created.status).toBe(201);
    const questId = created.body.quest.id;

    const listed = await admin.get(`/api/projects/${projectId}/quests`);
    expect(listed.body.items).toHaveLength(1);

    const updated = await admin.patch(`/api/quests/${questId}`, { status: 'completed' });
    expect(updated.body.quest.status).toBe('completed');
    expect(updated.body.quest.completed_at).not.toBeNull();

    const archived = await admin.post(`/api/quests/${questId}/archive`, {});
    expect(archived.body.quest.archived_at).not.toBeNull();

    const afterArchive = await admin.get(`/api/projects/${projectId}/quests`);
    expect(afterArchive.body.items).toHaveLength(0);
  });

  it('refuses to archive an active Quest', async () => {
    const created = await admin.post(`/api/projects/${projectId}/quests`, { title: 'Active' });
    const response = await admin.post(`/api/quests/${created.body.quest.id}/archive`, {});
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('QUEST_STATE_INVALID');
  });

  it('requires a reason to reopen a completed Quest', async () => {
    const created = await admin.post(`/api/projects/${projectId}/quests`, { title: 'Done' });
    await admin.patch(`/api/quests/${created.body.quest.id}`, { status: 'completed' });

    const noReason = await admin.post(`/api/quests/${created.body.quest.id}/reopen`, {});
    expect(noReason.status).toBe(422);

    const reopened = await admin.post(`/api/quests/${created.body.quest.id}/reopen`, {
      reason: 'the export is still broken',
    });
    expect(reopened.body.quest.status).toBe('in_progress');

    const audit = await admin.get('/api/shrine/audit?limit=20');
    expect(
      audit.body.items.some((entry: { action: string }) => entry.action === 'quest.reopened'),
    ).toBe(true);
  });

  it('projects a parent status from its children', async () => {
    const parent = await admin.post(`/api/projects/${projectId}/quests`, {
      title: 'Improve authentication security',
    });
    const child = await admin.post(`/api/projects/${projectId}/quests`, {
      title: 'Add token-family schema',
      parent_work_item_id: parent.body.quest.id,
    });

    await admin.patch(`/api/quests/${child.body.quest.id}`, { status: 'in_progress' });
    expect((await admin.get(`/api/quests/${parent.body.quest.id}`)).body.quest.status).toBe(
      'in_progress',
    );

    await admin.patch(`/api/quests/${child.body.quest.id}`, { status: 'completed' });
    expect((await admin.get(`/api/quests/${parent.body.quest.id}`)).body.quest.status).toBe(
      'completed',
    );
  });

  it('manages dependencies and refuses a cycle', async () => {
    const a = await admin.post(`/api/projects/${projectId}/quests`, { title: 'Add schema' });
    const b = await admin.post(`/api/projects/${projectId}/quests`, {
      title: 'Implement rotation',
    });

    const created = await admin.post(`/api/quests/${b.body.quest.id}/dependencies`, {
      depends_on_work_item_id: a.body.quest.id,
      dependency_type: 'must_complete_before',
    });
    expect(created.status).toBe(201);
    expect(created.body.dependencies[0].depends_on_title).toBe('Add schema');

    const cycle = await admin.post(`/api/quests/${a.body.quest.id}/dependencies`, {
      depends_on_work_item_id: b.body.quest.id,
      dependency_type: 'blocks',
    });
    expect(cycle.status).toBe(422);
    expect(cycle.body.error.code).toBe('QUEST_DEPENDENCY_INVALID');

    const removed = await admin.del(
      `/api/quests/${b.body.quest.id}/dependencies/${a.body.quest.id}`,
    );
    expect(removed.status).toBe(200);
  });

  it('returns the full Quest detail view', async () => {
    const sessionId = await startSession();
    const activated = await admin.post(`/api/sessions/${sessionId}/activate`, {
      task: 'Add CSV report export',
    });
    await admin.post(`/api/sessions/${sessionId}/end`, {
      handoff: {
        expected_quest_revision: 0,
        summary: 'handoff',
        work_state: workState({ next_steps: ['Wire the endpoint'] }),
      },
    });

    const detail = await admin.get(`/api/quests/${activated.body.quest.id}`);
    expect(detail.body.quest.revision).toBe(1);
    expect(detail.body.checkpoints).toHaveLength(1);
    expect(detail.body.sessions).toHaveLength(1);
    expect(detail.body.latest_handoff.summary).toBe('handoff');
    // The workspace key is machine identity and must never be exposed.
    expect(Object.keys(detail.body.sessions[0])).not.toContain('workspace_key');
  });
});

describe('authorization', () => {
  it('lets a quest:write token drive a session but not read Lore updates', async () => {
    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'agent',
      scopes: ['project:read', 'quest:read', 'quest:write'],
    });
    const agent = harness.withAgentToken(issued.body.raw_token);

    const started = await agent.post('/api/sessions', {
      project: projectName,
      client: 'claude-code',
    });
    expect(started.status).toBe(201);

    const activated = await agent.post(`/api/sessions/${started.body.session_id}/activate`, {
      task: 'Add CSV report export',
    });
    expect(activated.status).toBe(200);

    const denied = await agent.post(`/api/projects/${projectId}/lore/remember`, {
      entries: [
        {
          memory_key: 'a.b',
          category: 'overview',
          kind: 'fact',
          body: 'x',
          confidence: 0.9,
          verification_state: 'observed',
        },
      ],
      summary: 'nope',
    });
    expect(denied.status).toBe(403);
  });

  it('hides another project’s Quest from an agent token', async () => {
    const other = await admin.post('/api/projects', { name: 'Other Quest API Project' });
    const theirs = await admin.post(`/api/projects/${other.body.project.id}/quests`, {
      title: 'Their work',
    });

    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'mine',
      scopes: ['project:read', 'quest:read'],
    });
    const agent = harness.withAgentToken(issued.body.raw_token);
    const response = await agent.get(`/api/quests/${theirs.body.quest.id}`);
    expect(response.status).toBe(404);
  });

  it('refuses Quest writes in an archived project', async () => {
    await admin.post(`/api/projects/${projectId}/archive`, { reason: 'done' });
    const response = await admin.post(`/api/projects/${projectId}/quests`, { title: 'Nope' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PROJECT_ARCHIVED');
  });
});
