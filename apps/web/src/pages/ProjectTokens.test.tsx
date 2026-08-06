import type { Permission } from '@saga/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders, stubFetch, VIEWER_PERMISSIONS } from '../test-utils.jsx';
import { ProjectTokensPage } from './ProjectTokens.jsx';

/**
 * The project Tokens tab (ADR-0009). Listing and revoking agent tokens, the one security action
 * that had no console surface — a lost machine could only be cut off with `curl`.
 */

const TOKEN_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE = '/projects/ERP%20Backoffice/tokens';
const PATH = '/projects/:projectRef/tokens';
const LIST = 'GET /api/projects/ERP%20Backoffice/tokens';
const REVOKE = `POST /api/tokens/${TOKEN_ID}/revoke`;

// `security:manage` is admin-only, so an operator is the interesting negative case: it holds
// `shrine:operate` and every read, and would still only get a 403 here.
const OPERATOR_PERMISSIONS: readonly Permission[] = [
  'project:read',
  'project:write',
  'lore:read',
  'lore:propose',
  'lore:publish',
  'quest:read',
  'quest:write',
  'party:read',
  'party:claim',
  'shrine:read',
  'shrine:operate',
];

function agentToken(overrides: Record<string, unknown> = {}) {
  return {
    id: TOKEN_ID,
    project_id: '00000000-0000-4000-8000-000000000010',
    name: 'ERP Backoffice agent',
    token_prefix: 'saga_erp_ab12cd',
    scopes: ['project:read', 'lore:read'],
    client: 'saga-cli',
    created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    last_used_at: new Date(Date.now() - 3_600_000).toISOString(),
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function renderTokens(items: unknown[], permissions?: readonly Permission[]) {
  const stub = stubFetch({ [LIST]: { body: { items } }, [REVOKE]: { body: { token: items[0] } } });
  renderWithProviders(<ProjectTokensPage />, { route: ROUTE, path: PATH, permissions });
  return stub;
}

describe('Project tokens', () => {
  it('lists a token with its prefix, scopes and timestamps', async () => {
    renderTokens([agentToken()]);

    expect(await screen.findByText('saga_erp_ab12cd')).toBeInTheDocument();
    expect(screen.getByText('project:read, lore:read')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    // No expiry is worth flagging: revocation is then the only control that exists.
    expect(screen.getByText('never')).toBeInTheDocument();
  });

  it('tells two tokens apart when they share the default name', async () => {
    // The device flow names every token `<Project> agent` unless the administrator types
    // something, so the prefix is what identifies a row. If this regresses, the page cannot
    // answer "which of these is the laptop I lost", which is the reason it exists.
    renderTokens([
      agentToken(),
      agentToken({ id: '22222222-2222-4222-8222-222222222222', token_prefix: 'saga_erp_ef34gh' }),
    ]);

    expect(await screen.findByText('saga_erp_ab12cd')).toBeInTheDocument();
    expect(screen.getByText('saga_erp_ef34gh')).toBeInTheDocument();
    expect(screen.getAllByText('ERP Backoffice agent')).toHaveLength(2);
  });

  it('offers no Revoke on an expired token, which the API already refuses', async () => {
    renderTokens([agentToken({ expires_at: new Date(Date.now() - 86_400_000).toISOString() })]);

    expect(await screen.findByText('expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('hides revoked tokens until asked, and offers no Revoke on them', async () => {
    renderTokens([
      agentToken(),
      agentToken({
        id: '33333333-3333-4333-8333-333333333333',
        token_prefix: 'saga_erp_dead01',
        revoked_at: new Date().toISOString(),
      }),
    ]);

    expect(await screen.findByText('saga_erp_ab12cd')).toBeInTheDocument();
    expect(screen.queryByText('saga_erp_dead01')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Show revoked'));

    expect(screen.getByText('saga_erp_dead01')).toBeInTheDocument();
    expect(screen.getByText('revoked')).toBeInTheDocument();
    // One Revoke button, for the row that is still alive.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });

  it('explains an all-revoked project instead of rendering an empty table', async () => {
    // Nothing deletes a token, so this is the state an administrator reaches immediately after
    // revoking their last one. A headers-only table would look broken.
    renderTokens([agentToken({ revoked_at: new Date().toISOString() })]);

    expect(await screen.findByText('Every token here is revoked')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an empty state when the project has no tokens', async () => {
    renderTokens([]);

    expect(await screen.findByText('No agent tokens yet')).toBeInTheDocument();
  });

  it('requires a reason before it will revoke', async () => {
    renderTokens([agentToken()]);

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));

    const confirm = screen.getByRole('button', { name: 'Confirm revoke' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Reason (required)'), 'laptop stolen');
    expect(confirm).toBeEnabled();
  });

  it('posts the reason and the CSRF header', async () => {
    const { calls } = renderTokens([agentToken()]);

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'laptop stolen');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));

    const posted = calls.find((call) => call.method === 'POST');
    expect(posted?.url).toBe(`/api/tokens/${TOKEN_ID}/revoke`);
    expect(posted?.headers['x-saga-csrf']).toBe('test-csrf-token');
    // The whole body: the API rejects an empty reason, and nothing else belongs here.
    expect(posted?.body).toEqual({ reason: 'laptop stolen' });
  });

  it('offers an operator nothing, and asks the API for nothing', async () => {
    const { calls } = renderTokens([agentToken()], OPERATOR_PERMISSIONS);

    expect(await screen.findByText(/security:manage/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    // The gate is real, not cosmetic: no request is made that the API would refuse.
    expect(calls).toHaveLength(0);
  });

  it('offers a viewer nothing either', async () => {
    const { calls } = renderTokens([agentToken()], VIEWER_PERMISSIONS);

    expect(await screen.findByText(/security:manage/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
