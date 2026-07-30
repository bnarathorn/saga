import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App.jsx';
import { adminMe, projectSummary, renderWithProviders, stubFetch } from './test-utils.jsx';

/**
 * The router itself, exercised through the real `App`.
 *
 * `Layout.test.tsx` builds its own two-route tree, which is why a primary nav entry pointing at
 * a route `App` does not declare rendered the not-found fallback in production while every
 * test passed. These tests click the real navigation against the real route table.
 */

const NOT_FOUND = 'That page does not exist in Guild Hall.';

const empty = { items: [], next_cursor: null, has_more: false };

const latency = { count: 0, mean_ms: 0, p95_ms: 0, max_ms: 0 };

function metricsSummary() {
  return {
    collected_at: new Date().toISOString(),
    projects: { total: 1, active: 1 },
    jobs: {
      queued: 0,
      claimed: 0,
      retrying: 0,
      failed: 0,
      succeeded_last_hour: 0,
      oldest_queued_age_seconds: null,
    },
    outbox: { pending: 0, failed: 0 },
    services: { api_live: 1, worker_live: 1 },
    party: { active_agent_runs: 0, active_claims: 0 },
    lore: { entries: 12, stale: 0 },
    quest: { open: 2, blocked: 0 },
    sse: { clients: 1 },
    http: {
      since: new Date().toISOString(),
      requests: 0,
      duration: latency,
      errors_by_code: {},
    },
    latency: {
      lore_publish: latency,
      lore_search: latency,
      context_build: latency,
      memory_validation: latency,
      context_snapshot: latency,
      embedding: latency,
    },
    search: { total: 0, vector_fallback: 0 },
    context: { builds: 0, tokens_total: 0 },
    heartbeat_age_seconds: { api: 1, worker: 1, scheduler: null },
  };
}

const stubs = {
  '/api/auth/me': { body: adminMe },
  '/api/shrine/health': {
    body: {
      status: 'healthy',
      version: '0.1.0',
      checked_at: new Date().toISOString(),
      checks: [],
    },
  },
  '/api/shrine/metrics-summary': { body: { metrics: metricsSummary() } },
  '/api/shrine/events?limit=12': { body: empty },
  '/api/shrine/events?limit=25': { body: empty },
  '/api/shrine/jobs?limit=25': { body: empty },
  '/api/shrine/audit?limit=25': { body: empty },
  '/api/shrine/services': { body: { items: [] } },
  '/api/shrine/schema': {
    body: { schema: { current_version: 6, expected_version: 6, pending: [], applied: [] } },
  },
  '/api/shrine/config': {
    body: {
      config: {
        version: '0.1.0',
        node_env: 'test',
        started_at: new Date().toISOString(),
        database: { host: 'db', database: 'saga', pool_max: 10 },
        tls_enabled: false,
        embedding: { provider: 'fake', model: 'fake', dimensions: 8 },
        worker: { concurrency: 2, job_lease_seconds: 60, job_max_attempts: 5 },
        retention: { job_days: 7, system_event_days: 30, idempotency_hours: 24 },
        context_budgets: { core: 1000, task: 1000, continuation: 1000, party: 500 },
        party_mode: 'strict',
        dev_auth_bypass: false,
      },
    },
  },
  '/api/projects': { body: { ...empty, items: [projectSummary()] } },
};

function renderApp(route = '/') {
  // `App` provides its own permission and live contexts, so it is rendered bare.
  return renderWithProviders(<App />, { route });
}

describe('the Guild Hall route table', () => {
  it('resolves every primary nav entry to a real page', async () => {
    stubFetch(stubs);
    renderApp();

    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent ?? '');
    expect(labels).toEqual(['Dashboard', 'Projects', 'Lore', 'Quest Board', 'Party', 'Shrine']);

    for (const label of labels) {
      await userEvent.click(within(nav).getByRole('link', { name: label }));
      // The failure this guards against: a nav entry whose route `App` does not declare.
      await waitFor(() => expect(screen.queryByText(NOT_FOUND)).not.toBeInTheDocument());
    }
  });

  it('sends a per-project section to the picker when no project has been opened', async () => {
    stubFetch(stubs);
    renderApp('/lore');

    // Not the not-found fallback: Lore, Quests and Party all belong to a project.
    expect(await screen.findByText(/belong to a project/)).toBeInTheDocument();
    expect(screen.queryByText(NOT_FOUND)).not.toBeInTheDocument();
  });

  it('keeps an unknown project sub-path inside the project shell', async () => {
    stubFetch({
      ...stubs,
      '/api/projects/ERP%20Backoffice': { body: { project: projectSummary() } },
    });
    renderApp('/projects/ERP%20Backoffice/nonsense');

    expect(await screen.findByText(/This project has no such section/)).toBeInTheDocument();
  });

  it('still shows the top-level fallback for a route outside any project', async () => {
    stubFetch(stubs);
    renderApp('/there-is-no-such-page');

    expect(await screen.findByText(NOT_FOUND)).toBeInTheDocument();
  });

  it('sends an unauthenticated visitor to the login page', async () => {
    stubFetch({
      ...stubs,
      '/api/auth/me': { body: { authenticated: false, actor_type: 'anonymous' } },
    });
    renderApp('/projects');

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  it('returns an unauthenticated visitor to the page they were sent to, query string intact', async () => {
    // The CLI's `verification_uri_complete` carries the device code as `?code=`. Losing that
    // query string across the login bounce would defeat the whole device-approval flow, so
    // this exercises the full round trip: bounced to `/login`, signs in, lands back on
    // `/device?code=…` rather than the dashboard.
    let loggedIn = false;
    stubFetch({
      ...stubs,
      '/api/auth/me': () => ({
        body: loggedIn ? adminMe : { authenticated: false, actor_type: 'anonymous' },
      }),
      'POST /api/auth/login': () => {
        loggedIn = true;
        return {
          body: { user: adminMe.user, csrf_token: 'test-csrf-token', expires_at: new Date().toISOString() },
        };
      },
      '/api/auth/device/pending': { body: { items: [] } },
      // A project must exist for the approval form to render at all (see Device.test.tsx's
      // no-active-projects case) — this test is about the login round trip, not that empty
      // state, so it stubs one active project to keep the form on screen.
      '/api/projects?status=active&limit=200': { body: { ...empty, items: [projectSummary()] } },
    });
    renderApp('/device?code=WORD-WORD');

    // Bounced through login first — the dashboard and Device page are both absent.
    const emailField = await screen.findByLabelText(/email/i);
    expect(screen.queryByText('Approve a device sign-in')).not.toBeInTheDocument();

    await userEvent.type(emailField, 'admin@saga.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Lands on the device-approval page it was originally sent to, not `/`.
    expect(await screen.findByText('Approve a device sign-in')).toBeInTheDocument();
    expect(screen.getByLabelText('Device code')).toHaveValue('WORD-WORD');
  });

  it('falls back to `/` instead of throwing when the stashed location is a `//`-prefixed pathname', async () => {
    // A location whose pathname starts with `//` (e.g. a user typing `https://host//evil.com`)
    // would make `navigate()` attempt a cross-origin `history.pushState`, which throws a
    // SecurityError rather than redirecting. This is not exploitable — an attacker gains
    // nothing over linking to their site directly — but landing safely on `/` instead of
    // crashing the app is a cheap guard worth having.
    let loggedIn = false;
    stubFetch({
      ...stubs,
      '/api/auth/me': () => ({
        body: loggedIn ? adminMe : { authenticated: false, actor_type: 'anonymous' },
      }),
      'POST /api/auth/login': () => {
        loggedIn = true;
        return {
          body: { user: adminMe.user, csrf_token: 'test-csrf-token', expires_at: new Date().toISOString() },
        };
      },
    });
    // The catch-all route stashes this location as `state.from` before bouncing to `/login`,
    // the same mechanism the round-trip test above exercises — only the pathname here is the
    // `//`-prefixed one under test.
    renderApp('//evil.com');

    const emailField = await screen.findByLabelText(/email/i);
    await userEvent.type(emailField, 'admin@saga.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Landed on the dashboard, and no not-found fallback. Note this asserts the end state only:
    // it passes with the guard reverted, because `MemoryRouter` never calls the real
    // `history.pushState` and so cannot reproduce the SecurityError the guard exists to avoid.
    // The guard itself is asserted directly in `Login.test.tsx` — do not treat this case as its
    // regression test.
    expect(await screen.findByText('Dashboard', { selector: 'h1' })).toBeInTheDocument();
    expect(screen.queryByText(NOT_FOUND)).not.toBeInTheDocument();
  });

  it('stays on screen and explains itself when the API cannot be reached', async () => {
    stubFetch({
      '/api/auth/me': {
        status: 503,
        body: {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Saga is down.',
            details: {},
            request_id: 'req_1',
          },
        },
      },
    });
    renderApp();

    expect(await screen.findByText('Saga is unreachable')).toBeInTheDocument();
    expect(screen.getByText(/Static assets are served independently/)).toBeInTheDocument();
  });
});
