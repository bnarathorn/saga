import type { Permission } from '@saga/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders, stubFetch, VIEWER_PERMISSIONS } from '../test-utils.jsx';
import { PartyPage, presence } from './Party.jsx';

const REF = 'ERP%20Backoffice';
const STATUS = `/api/projects/${REF}/party/status`;
const CLAIMS = `/api/projects/${REF}/party/claims?include_finished=true`;
const RUN_ID = '00000000-0000-4000-8000-000000000300';
const CLAIM_ID = '00000000-0000-4000-8000-000000000400';

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: CLAIM_ID,
    resource_type: 'file',
    resource_key: 'apps/api/reports.ts',
    resource_policy: 'exclusive',
    mode: 'write',
    state: 'active',
    agent_run_id: RUN_ID,
    work_item_id: '00000000-0000-4000-8000-000000000001',
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

/** A claim the server has not swept yet: still `active`, but its lease ran out. */
function lapsedClaim(overrides: Record<string, unknown> = {}) {
  return claim({ lease_expires_at: new Date(Date.now() - 60_000).toISOString(), ...overrides });
}

const liveStatus = {
  body: { mode: 'strict', project_id: 'p1', active_agents: [], claims: [], overlaps: [] },
};

function activeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    project_id: '00000000-0000-4000-8000-000000000010',
    session_id: '00000000-0000-4000-8000-000000000110',
    work_item_id: null,
    agent_instance_id: 'claude-code:11111111',
    client: 'saga-mcp',
    workspace_label: 'machine-a:saga',
    state: 'active',
    live: true,
    heartbeat_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    started_at: new Date().toISOString(),
    ended_at: null,
    quest_title: null,
    scope: {},
    claims: [],
    ...overrides,
  };
}

function renderParty(permissions?: readonly Permission[]) {
  return renderWithProviders(<PartyPage />, {
    route: `/projects/${REF}/party`,
    path: '/projects/:projectRef/party',
    ...(permissions === undefined ? {} : { permissions }),
  });
}

describe('presence', () => {
  it('separates a live lease from work actually being done', () => {
    expect(presence({ live: true, work_item_id: null })).toEqual({
      tone: 'neutral',
      label: 'idle',
    });
    expect(presence({ live: true, work_item_id: 'w1' })).toEqual({
      tone: 'good',
      label: 'working',
    });
  });

  it('calls a run with recent tool activity working, and one without it silent', () => {
    const now = Date.parse('2026-08-11T12:00:00Z');
    const attached = { live: true, work_item_id: 'w1' };

    expect(presence({ ...attached, last_activity_at: '2026-08-11T11:59:00Z' }, now)).toMatchObject({
      label: 'working',
    });
    // Eleven minutes. This is the state a checkpoint-on-a-timer used to exist to rule out.
    expect(presence({ ...attached, last_activity_at: '2026-08-11T11:49:00Z' }, now)).toMatchObject({
      label: 'silent',
      tone: 'warn',
    });
  });

  it('does not accuse an older CLI of silence it cannot disprove', () => {
    // A run from a build that never reports activity has `last_activity_at` null. Unknown is
    // not the same as silent, and badging it "silent" would libel every agent mid-rollout.
    expect(presence({ live: true, work_item_id: 'w1', last_activity_at: null })).toMatchObject({
      label: 'working',
    });
    expect(presence({ live: true, work_item_id: 'w1' })).toMatchObject({ label: 'working' });
  });

  it('still reports an expired lease as expired, whether or not a Quest was attached', () => {
    for (const workItemId of [null, 'w1']) {
      expect(presence({ live: false, work_item_id: workItemId })).toEqual({
        tone: 'warn',
        label: 'lease expired',
      });
    }
  });
});

describe('Party page', () => {
  it('explains a disabled Party rather than showing an empty roster', async () => {
    stubFetch({
      [STATUS]: {
        body: { mode: 'off', project_id: 'p1', active_agents: [], claims: [], overlaps: [] },
      },
      [CLAIMS]: { body: { items: [] } },
    });
    renderParty();

    expect(await screen.findByText(/Live coordination is disabled/)).toBeInTheDocument();
    expect(screen.getByText('PARTY_MODE=off')).toBeInTheDocument();
  });

  it('tells apart two agents in the same folder', async () => {
    // They share `client` and `workspace_label`, so the roster used to show one row twice.
    stubFetch({
      [STATUS]: {
        body: {
          ...liveStatus.body,
          active_agents: [
            activeAgent(),
            activeAgent({
              id: '00000000-0000-4000-8000-000000000301',
              agent_instance_id: 'codex:22222222',
            }),
          ],
        },
      },
      [CLAIMS]: { body: { items: [] } },
    });
    renderParty();

    expect(await screen.findByText('claude-code:11111111')).toBeInTheDocument();
    expect(screen.getByText('codex:22222222')).toBeInTheDocument();
  });

  it('badges an agent that holds a lease but has taken no Quest as idle, not live', async () => {
    // The bug this replaces: a session that opened and never called saga_activate_task
    // heartbeats exactly like one mid-Quest, so the board implied progress that did not exist.
    stubFetch({
      [STATUS]: {
        body: {
          ...liveStatus.body,
          active_agents: [
            activeAgent(),
            activeAgent({
              id: '00000000-0000-4000-8000-000000000302',
              agent_instance_id: 'codex:33333333',
              work_item_id: '00000000-0000-4000-8000-000000000001',
              quest_title: 'Add CSV report export',
            }),
          ],
        },
      },
      [CLAIMS]: { body: { items: [] } },
    });
    renderParty();

    expect(await screen.findByText('idle')).toBeInTheDocument();
    expect(screen.getByText('working')).toBeInTheDocument();
    // Counted all the same: it is present, and hiding it would lose the coordination signal.
    expect(screen.getByText('No Quest attached yet')).toBeInTheDocument();
  });

  it('releases a claim whose lease has lapsed, on behalf of its own agent run', async () => {
    const { calls } = stubFetch({
      [STATUS]: liveStatus,
      [CLAIMS]: { body: { items: [lapsedClaim()] } },
      [`POST /api/party/claims/${CLAIM_ID}/release`]: {
        body: { claim: claim({ state: 'released' }) },
      },
    });
    renderParty();

    expect(await screen.findByText('lease lapsed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Release' }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.endsWith('/release'));
      expect(post?.body).toEqual({
        agent_run_id: RUN_ID,
        reason: 'Released from Guild Hall after the lease lapsed.',
      });
    });
  });

  it('offers revocation, not release, while the lease is still live', async () => {
    stubFetch({ [STATUS]: liveStatus, [CLAIMS]: { body: { items: [claim()] } } });
    renderParty();

    expect(await screen.findByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument();
  });

  it('requires a reason and a confirmation before revoking', async () => {
    const { calls } = stubFetch({
      [STATUS]: liveStatus,
      [CLAIMS]: { body: { items: [claim()] } },
      [`POST /api/party/claims/${CLAIM_ID}/revoke`]: {
        body: { claim: claim({ state: 'revoked' }) },
      },
    });
    renderParty();

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    const confirm = screen.getByRole('button', { name: 'Confirm revoke' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason (required)'), 'the agent crashed');
    await userEvent.click(confirm);

    await waitFor(() => {
      const post = calls.find((call) => call.url.endsWith('/revoke'));
      expect(post?.body).toEqual({ reason: 'the agent crashed', confirm: true });
    });
  });

  it('offers a viewer no claim action at all', async () => {
    stubFetch({ [STATUS]: liveStatus, [CLAIMS]: { body: { items: [lapsedClaim()] } } });
    renderParty(VIEWER_PERMISSIONS);

    const claims = await screen.findByRole('region', { name: 'Claims' });
    expect(await within(claims).findByText('lease lapsed')).toBeInTheDocument();
    expect(within(claims).queryByRole('button', { name: 'Release' })).not.toBeInTheDocument();
    expect(within(claims).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('reports a failed claims fetch instead of reading as "no claims"', async () => {
    stubFetch({
      [STATUS]: liveStatus,
      [CLAIMS]: {
        status: 500,
        body: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The claims query failed.',
            details: {},
            request_id: 'req_2',
          },
        },
      },
    });
    renderParty();

    const claims = await screen.findByRole('region', { name: 'Claims' });
    expect(await within(claims).findByRole('alert')).toHaveTextContent('The claims query failed.');
    expect(within(claims).queryByText('No claims recorded')).not.toBeInTheDocument();
  });
});
