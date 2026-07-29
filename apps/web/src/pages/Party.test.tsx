import type { Permission } from '@saga/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders, stubFetch, VIEWER_PERMISSIONS } from '../test-utils.jsx';
import { PartyPage } from './Party.jsx';

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

function renderParty(permissions?: readonly Permission[]) {
  return renderWithProviders(<PartyPage />, {
    route: `/projects/${REF}/party`,
    path: '/projects/:projectRef/party',
    ...(permissions === undefined ? {} : { permissions }),
  });
}

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
