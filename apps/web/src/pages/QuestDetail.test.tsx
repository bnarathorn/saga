import type { Permission } from '@saga/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders, stubFetch, VIEWER_PERMISSIONS } from '../test-utils.jsx';
import { QuestDetailPage } from './QuestDetail.jsx';

const REF = 'ERP%20Backoffice';
const QUEST_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_QUEST_ID = '00000000-0000-4000-8000-000000000002';
const RUN_ID = '00000000-0000-4000-8000-000000000300';
const DETAIL = `/api/quests/${QUEST_ID}`;
const QUEST_LIST = `/api/projects/${REF}/quests?limit=200`;
const PARTY_STATUS = `/api/projects/${REF}/party/status`;
const PARTY_CLAIMS = `/api/projects/${REF}/party/claims?include_finished=true`;

function quest(overrides: Record<string, unknown> = {}) {
  return {
    id: QUEST_ID,
    project_id: '00000000-0000-4000-8000-000000000010',
    parent_work_item_id: null,
    title: 'Add CSV report export',
    objective: 'Let finance export the monthly ledger.',
    status: 'in_progress',
    priority: 'normal',
    scope: { modules: ['reports'] },
    revision: 2,
    latest_checkpoint_id: null,
    created_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    completed_at: null,
    archived_at: null,
    ...overrides,
  };
}

function workState(overrides: Record<string, unknown> = {}) {
  return {
    goal: 'Export the ledger as CSV.',
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

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000100',
    session_id: '00000000-0000-4000-8000-000000000110',
    work_item_id: QUEST_ID,
    kind: 'final_handoff',
    summary: 'Handing over mid-export',
    work_state: workState(),
    base_work_item_revision: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000400',
    resource_type: 'file',
    resource_key: 'apps/api/reports.ts',
    resource_policy: 'exclusive',
    mode: 'write',
    state: 'active',
    agent_run_id: RUN_ID,
    work_item_id: QUEST_ID,
    work_item_title: 'Add CSV report export',
    client: 'claude-code',
    base_fingerprint: null,
    acquired_at: new Date(Date.now() - 3_600_000).toISOString(),
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    released_at: null,
    release_reason: null,
    ...overrides,
  };
}

function agentRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    project_id: '00000000-0000-4000-8000-000000000010',
    session_id: '00000000-0000-4000-8000-000000000110',
    work_item_id: QUEST_ID,
    agent_instance_id: 'claude-code:11111111',
    client: 'claude-code',
    workspace_label: 'machine-a:erp-main',
    state: 'active',
    live: true,
    heartbeat_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    started_at: new Date().toISOString(),
    ended_at: null,
    ...overrides,
  };
}

function step(overrides: Record<string, unknown> = {}) {
  return {
    id: `s${String(overrides.ordinal ?? 1)}`,
    work_item_id: QUEST_ID,
    ordinal: 1,
    title: 'A step',
    status: 'pending',
    completed_at: null,
    completed_by_session_id: null,
    completed_by_checkpoint_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function detailBody(overrides: Record<string, unknown> = {}) {
  return {
    quest: quest(),
    children: [],
    dependencies: [],
    checkpoints: [],
    sessions: [],
    latest_handoff: null,
    plan: null,
    ...overrides,
  };
}

const partyStubs = {
  [PARTY_STATUS]: {
    body: { mode: 'strict', project_id: 'p1', active_agents: [], claims: [], overlaps: [] },
  },
  [PARTY_CLAIMS]: { body: { items: [] } },
};

function renderDetail(permissions?: readonly Permission[]) {
  return renderWithProviders(<QuestDetailPage />, {
    route: `/projects/${REF}/quests/${QUEST_ID}`,
    path: '/projects/:projectRef/quests/:questId',
    ...(permissions === undefined ? {} : { permissions }),
  });
}

describe('Quest Detail', () => {
  it('lists the plan in order with each step’s status', async () => {
    stubFetch({
      ...partyStubs,
      [DETAIL]: {
        body: detailBody({
          plan: {
            steps: [
              step({ ordinal: 1, title: 'Write the migration', status: 'done' }),
              step({ ordinal: 2, title: 'Wire the routes', status: 'in_progress' }),
              step({ ordinal: 3, title: 'Update the docs', status: 'pending' }),
            ],
            progress: {
              total: 3,
              done: 1,
              skipped: 0,
              remaining: 2,
              all_settled: false,
              next_ordinal: 2,
            },
          },
        }),
      },
    });
    renderDetail();

    expect(await screen.findByText('Write the migration')).toBeInTheDocument();
    expect(screen.getByText('Wire the routes')).toBeInTheDocument();
    expect(screen.getByText('Update the docs')).toBeInTheDocument();
    expect(screen.getByText('1/3 done')).toBeInTheDocument();
  });

  it('says a finished plan is waiting on a person when the Quest is still open', async () => {
    // The whole point of the panel on a `manual` project: without this line the Quest looks
    // merely unfinished, and nobody knows it is theirs to close.
    stubFetch({
      ...partyStubs,
      [DETAIL]: {
        body: detailBody({
          plan: {
            steps: [step({ ordinal: 1, title: 'Write the migration', status: 'done' })],
            progress: {
              total: 1,
              done: 1,
              skipped: 0,
              remaining: 0,
              all_settled: true,
              next_ordinal: null,
            },
          },
        }),
      },
    });
    renderDetail();

    expect(await screen.findByText(/Every step is settled/)).toBeInTheDocument();
  });

  it('tells a reader how a plan gets declared when there is none', async () => {
    stubFetch({ ...partyStubs, [DETAIL]: { body: detailBody() } });
    renderDetail();

    expect(await screen.findByText('No plan declared')).toBeInTheDocument();
  });

  it('edits the objective and the declared scope through one PATCH', async () => {
    const { calls } = stubFetch({
      ...partyStubs,
      [DETAIL]: { body: detailBody() },
      [`PATCH ${DETAIL}`]: { body: { quest: quest() } },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit objective and scope' }));
    const objective = screen.getByLabelText('Objective');
    await userEvent.clear(objective);
    await userEvent.type(objective, 'Export the ledger for finance.');
    await userEvent.type(
      screen.getByLabelText('Files'),
      'apps/api/reports.ts, apps/web/Report.tsx',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({
        objective: 'Export the ledger for finance.',
        scope: {
          modules: ['reports'],
          files: ['apps/api/reports.ts', 'apps/web/Report.tsx'],
        },
      });
    });
  });

  it('clears the objective rather than storing an empty string', async () => {
    const { calls } = stubFetch({
      ...partyStubs,
      [DETAIL]: { body: detailBody({ quest: quest({ scope: {} }) }) },
      [`PATCH ${DETAIL}`]: { body: { quest: quest() } },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit objective and scope' }));
    await userEvent.clear(screen.getByLabelText('Objective'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({ objective: null, scope: {} });
    });
  });

  it('creates a dependency on another Quest in the project', async () => {
    const { calls } = stubFetch({
      ...partyStubs,
      [DETAIL]: { body: detailBody() },
      [QUEST_LIST]: {
        body: {
          items: [quest(), quest({ id: OTHER_QUEST_ID, title: 'Rework the ledger schema' })],
          next_cursor: null,
          has_more: false,
        },
      },
      [`POST /api/quests/${QUEST_ID}/dependencies`]: { status: 201, body: { dependencies: [] } },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    // The Quest itself is never offered as its own dependency.
    const target = await screen.findByLabelText('Depends on');
    expect(within(target).queryByText('Add CSV report export')).not.toBeInTheDocument();

    await userEvent.selectOptions(target, OTHER_QUEST_ID);
    await userEvent.selectOptions(screen.getByLabelText('This Quest'), 'requires_output');
    await userEvent.click(screen.getByRole('button', { name: 'Add dependency' }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.endsWith('/dependencies'));
      expect(post?.body).toEqual({
        depends_on_work_item_id: OTHER_QUEST_ID,
        dependency_type: 'requires_output',
      });
    });
  });

  it('removes a dependency', async () => {
    const { calls } = stubFetch({
      ...partyStubs,
      [DETAIL]: {
        body: detailBody({
          dependencies: [
            {
              work_item_id: QUEST_ID,
              depends_on_work_item_id: OTHER_QUEST_ID,
              depends_on_title: 'Rework the ledger schema',
              depends_on_status: 'open',
              dependency_type: 'blocks',
              created_at: new Date().toISOString(),
            },
          ],
        }),
      },
      [`DELETE /api/quests/${QUEST_ID}/dependencies/${OTHER_QUEST_ID}`]: { body: { ok: true } },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
  });

  it('archives a completed Quest only after confirmation', async () => {
    const { calls } = stubFetch({
      ...partyStubs,
      [DETAIL]: { body: detailBody({ quest: quest({ status: 'completed' }) }) },
      [`POST /api/quests/${QUEST_ID}/archive`]: {
        body: { quest: quest({ status: 'completed', archived_at: new Date().toISOString() }) },
      },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(calls.some((call) => call.url.endsWith('/archive'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Confirm archive' }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/archive'))).toBe(true);
    });
  });

  it('does not offer archiving for a Quest that is still open', async () => {
    stubFetch({ ...partyStubs, [DETAIL]: { body: detailBody() } });
    renderDetail();

    await screen.findByRole('button', { name: 'Edit objective and scope' });
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('renders changed files, commands and test results from the handoff', async () => {
    stubFetch({
      ...partyStubs,
      [DETAIL]: {
        body: detailBody({
          latest_handoff: checkpoint({
            work_state: workState({
              changed_files: [{ path: 'apps/api/reports.ts', base_hash: 'a', current_hash: 'b' }],
              commands: [
                { command: 'pnpm test:api', status: 'failed', summary: '2 failing assertions' },
              ],
              tests: [{ name: 'reports.api.test.ts', status: 'failed', summary: 'CSV header' }],
            }),
          }),
        }),
      },
    });
    renderDetail();

    expect(await screen.findByText('Changed files')).toBeInTheDocument();
    expect(screen.getByText('apps/api/reports.ts')).toBeInTheDocument();
    expect(screen.getByText('pnpm test:api')).toBeInTheDocument();
    expect(screen.getByText('2 failing assertions')).toBeInTheDocument();
    expect(screen.getByText('Test results')).toBeInTheDocument();
    expect(screen.getByText('reports.api.test.ts')).toBeInTheDocument();
  });

  it('counts commands in a checkpoint summary', async () => {
    stubFetch({
      ...partyStubs,
      [DETAIL]: {
        body: detailBody({
          checkpoints: [
            checkpoint({
              kind: 'milestone',
              work_state: workState({
                commands: [{ command: 'pnpm build' }, { command: 'pnpm lint' }],
              }),
            }),
          ],
        }),
      },
    });
    renderDetail();
    expect(await screen.findByText('2 commands')).toBeInTheDocument();
  });

  it('shows the Party members and claims attached to this Quest', async () => {
    stubFetch({
      [DETAIL]: { body: detailBody() },
      [PARTY_STATUS]: {
        body: {
          mode: 'strict',
          project_id: 'p1',
          active_agents: [
            { ...agentRun(), quest_title: 'Add CSV report export', scope: {}, claims: [] },
            {
              ...agentRun({
                id: 'other-run',
                work_item_id: OTHER_QUEST_ID,
                agent_instance_id: 'codex:22222222',
                client: 'codex',
              }),
              quest_title: 'Rework the ledger schema',
              scope: {},
              claims: [],
            },
          ],
          claims: [],
          overlaps: [],
        },
      },
      [PARTY_CLAIMS]: {
        body: {
          items: [
            claim(),
            claim({ id: 'other-claim', work_item_id: OTHER_QUEST_ID, resource_key: 'other.ts' }),
          ],
        },
      },
    });
    renderDetail();

    const party = await screen.findByRole('region', { name: 'Party' });
    expect(await within(party).findByText('claude-code:11111111')).toBeInTheDocument();
    expect(await within(party).findByText('file:apps/api/reports.ts')).toBeInTheDocument();
    // Another Quest's agent and claim must not leak into this Quest's panel.
    expect(within(party).queryByText('codex')).not.toBeInTheDocument();
    expect(within(party).getByText('file:apps/api/reports.ts')).toBeInTheDocument();
    expect(within(party).queryByText('file:other.ts')).not.toBeInTheDocument();
  });

  it('reports a failed Party fetch instead of claiming nobody is working', async () => {
    stubFetch({
      [DETAIL]: { body: detailBody() },
      [PARTY_STATUS]: {
        status: 503,
        body: {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Party is unavailable.',
            details: {},
            request_id: 'req_1',
          },
        },
      },
      [PARTY_CLAIMS]: { body: { items: [] } },
    });
    renderDetail();

    const party = await screen.findByRole('region', { name: 'Party' });
    expect(await within(party).findByRole('alert')).toHaveTextContent('Party is unavailable.');
    expect(within(party).queryByText(/No agent is working on this Quest/)).not.toBeInTheDocument();
  });

  it('hides every write action from a viewer', async () => {
    stubFetch({
      ...partyStubs,
      [DETAIL]: { body: detailBody({ quest: quest({ status: 'completed' }) }) },
    });
    renderDetail(VIEWER_PERMISSIONS);

    expect(await screen.findByText('Add CSV report export')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit objective and scope' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });
});
