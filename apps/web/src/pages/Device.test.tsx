import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  projectSummary,
  renderWithProviders,
  stubFetch,
  VIEWER_PERMISSIONS,
} from '../test-utils.jsx';
import { DevicePage } from './Device.jsx';

/**
 * The CLI device-approval page (spec 12.1, step 2/3). `saga connect` opens
 * `verification_uri_complete`, which carries the pending code as `?code=`; this page reads it,
 * shows what is waiting, and lets an administrator approve it into a project-scoped token.
 */

const activeProjects = { items: [projectSummary()], next_cursor: null, has_more: false };

function pendingItem(overrides: Record<string, unknown> = {}) {
  return {
    user_code: 'WORD-WORD',
    client: 'saga-cli',
    workspace_label: 'erp-backoffice',
    requested_scopes: ['project:read', 'lore:read'],
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

function approvedToken(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000900',
    project_id: '00000000-0000-4000-8000-000000000010',
    name: 'ERP Backoffice agent',
    token_prefix: 'sagat_ab12',
    scopes: [
      'project:read',
      'lore:read',
      'lore:propose',
      'quest:read',
      'quest:write',
      'party:heartbeat',
      'party:claim',
    ],
    client: 'saga-cli',
    created_at: new Date().toISOString(),
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

async function selectProject(name = 'ERP Backoffice') {
  const select = await screen.findByLabelText('Project');
  await waitFor(() => expect(within(select).getByText(name)).toBeInTheDocument());
  await userEvent.selectOptions(select, name);
  return select;
}

describe('Device page', () => {
  it('shows the pending device requests', async () => {
    stubFetch({
      '/api/auth/device/pending': { body: { items: [pendingItem()] } },
      '/api/projects?status=active&limit=200': { body: activeProjects },
    });
    renderWithProviders(<DevicePage />, { route: '/device' });

    expect(await screen.findByText('saga-cli')).toBeInTheDocument();
    expect(screen.getByText('erp-backoffice')).toBeInTheDocument();
    expect(screen.getByText('project:read, lore:read')).toBeInTheDocument();
  });

  it('shows an actionable empty state when nothing is waiting', async () => {
    stubFetch({
      '/api/auth/device/pending': { body: { items: [] } },
      '/api/projects?status=active&limit=200': { body: activeProjects },
    });
    renderWithProviders(<DevicePage />, { route: '/device' });

    expect(await screen.findByText('No device requests are waiting')).toBeInTheDocument();
  });

  it('shows an explanatory empty state and offers no Approve control when there are no active projects', async () => {
    stubFetch({
      '/api/auth/device/pending': { body: { items: [pendingItem()] } },
      '/api/projects?status=active&limit=200': {
        body: { items: [], next_cursor: null, has_more: false },
      },
    });
    renderWithProviders(<DevicePage />, { route: '/device?code=WORD-WORD' });

    expect(await screen.findByText('No active projects')).toBeInTheDocument();
    // The dead form — a permanently disabled Approve button with no explanation — must be
    // gone entirely, not merely unusable.
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('prefills the device code from the `code` query parameter `verification_uri_complete` sets', async () => {
    stubFetch({
      '/api/auth/device/pending': { body: { items: [pendingItem()] } },
      '/api/projects?status=active&limit=200': { body: activeProjects },
    });
    renderWithProviders(<DevicePage />, { route: '/device?code=WORD-WORD' });

    expect(await screen.findByLabelText('Device code')).toHaveValue('WORD-WORD');
  });

  it('sends the correct approve body, including the CSRF header, and reports success', async () => {
    const { calls } = stubFetch({
      '/api/auth/device/pending': { body: { items: [pendingItem()] } },
      '/api/projects?status=active&limit=200': { body: activeProjects },
      'POST /api/auth/device/approve': { body: { token: approvedToken() } },
    });
    renderWithProviders(<DevicePage />, { route: '/device?code=WORD-WORD' });

    await selectProject();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      const post = calls.find((call) => call.url === '/api/auth/device/approve');
      expect(post).toBeDefined();
      expect(post!.headers['x-saga-csrf']).toBe('test-csrf-token');
      // Token name and expiry were left blank, so they must be entirely absent — the API
      // fills the default name and never-expires only when the field is missing, not when
      // it is an empty string.
      expect(post!.body).toEqual({
        user_code: 'WORD-WORD',
        // The project UUID, not its display name — a project renamed between page load and
        // approval must not break the reference. `projectSummary()`'s `id` field is the source
        // of truth here, not a hardcoded guess.
        project_ref: '00000000-0000-4000-8000-000000000010',
        scopes: [
          'project:read',
          'lore:read',
          'lore:propose',
          'quest:read',
          'quest:write',
          'party:heartbeat',
          'party:claim',
        ],
      });
    });

    expect(await screen.findByText(/Approved/)).toHaveTextContent('ERP Backoffice agent');
  });

  it('hides approval from a user without security:manage, and never requests the pending list', async () => {
    const { calls } = stubFetch({});
    renderWithProviders(<DevicePage />, {
      route: '/device?code=WORD-WORD',
      permissions: VIEWER_PERMISSIONS,
    });

    expect(await screen.findByText(/security:manage/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Device code')).not.toBeInTheDocument();
    // The gate is not merely cosmetic: nothing is fetched for a caller who cannot act on it,
    // matching the server, which requires the same permission for both endpoints.
    expect(calls).toHaveLength(0);
  });

  it('disables Approve while the request is in flight, so a second click cannot double-submit', async () => {
    stubFetch({
      '/api/auth/device/pending': { body: { items: [pendingItem()] } },
      '/api/projects?status=active&limit=200': { body: activeProjects },
    });

    // The approve POST is intercepted separately so its resolution can be held open — Guild
    // Hall sends no `Idempotency-Key` (see HANDOFF.md), so the button's disabled state while
    // in flight is the only thing standing between one click and two audit records.
    let approveCalls = 0;
    let resolveApprove!: (value: Response) => void;
    const approveResponse = new Promise<Response>((resolve) => {
      resolveApprove = resolve;
    });
    const passthrough = global.fetch as typeof fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/auth/device/approve' && init?.method === 'POST') {
          approveCalls += 1;
          return approveResponse;
        }
        return passthrough(input, init);
      }),
    );

    renderWithProviders(<DevicePage />, { route: '/device?code=WORD-WORD' });
    await selectProject();

    const button = screen.getByRole('button', { name: 'Approve' });
    await userEvent.click(button);

    const pendingButton = screen.getByRole('button', { name: 'Approving…' });
    expect(pendingButton).toBeDisabled();

    // A disabled button does not dispatch click at all — the same guard `Shrine.tsx` and
    // `Party.tsx` rely on for their confirm actions.
    await userEvent.click(pendingButton);
    expect(approveCalls).toBe(1);

    resolveApprove(
      new Response(JSON.stringify({ token: approvedToken() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    // The mutation settling clears `isPending` — the button leaves "Approving…" and is
    // enabled again by the form's own read-out. (The form itself resets on success, so it is
    // immediately disabled again for a different, legitimate reason: nothing is filled in.)
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(await screen.findByText(/Approved/)).toHaveTextContent('ERP Backoffice agent');
  });
});
