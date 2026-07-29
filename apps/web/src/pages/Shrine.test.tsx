import type { Permission } from '@saga/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders, stubFetch, VIEWER_PERMISSIONS } from '../test-utils.jsx';
import { ShrinePage } from './Shrine.jsx';

const JOB_ID = '00000000-0000-4000-8000-000000000700';
const empty = { items: [], next_cursor: null, has_more: false };
const latency = { count: 0, mean_ms: 0, p95_ms: 0, max_ms: 0 };

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    collected_at: new Date().toISOString(),
    projects: { total: 1, active: 1 },
    jobs: {
      queued: 0,
      claimed: 0,
      retrying: 0,
      failed: 0,
      succeeded_last_hour: 12,
      oldest_queued_age_seconds: null,
    },
    outbox: { pending: 0, failed: 0 },
    services: { api_live: 1, worker_live: 1 },
    party: { active_agent_runs: 0, active_claims: 0 },
    lore: { entries: 12, stale: 0 },
    quest: { open: 2, blocked: 0 },
    sse: { clients: 1 },
    http: { since: new Date().toISOString(), requests: 40, duration: latency, errors_by_code: {} },
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
    heartbeat_age_seconds: { api: 2, worker: 3, scheduler: null },
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    project_id: null,
    job_type: 'memory_validation',
    entity_type: null,
    entity_id: null,
    dedupe_key: null,
    state: 'failed',
    priority: 0,
    payload: {},
    result: null,
    attempts: 5,
    max_attempts: 5,
    run_after: new Date().toISOString(),
    claimed_by: null,
    claimed_at: null,
    lease_expires_at: null,
    last_error: 'the embedding provider is unavailable',
    correlation_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      version: '0.1.0',
      node_env: 'production',
      started_at: new Date().toISOString(),
      database: { host: 'db.internal:5432', database: 'saga_prod', pool_max: 10 },
      tls_enabled: true,
      embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
      worker: { concurrency: 4, job_lease_seconds: 60, job_max_attempts: 5 },
      retention: { job_days: 7, system_event_days: 30, idempotency_hours: 24 },
      context_budgets: { core: 1200, task: 1500, continuation: 1500, party: 600 },
      party_mode: 'strict',
      dev_auth_bypass: false,
      ...overrides,
    },
  };
}

const stubs = {
  '/api/shrine/health': {
    body: {
      status: 'healthy',
      version: '0.1.0',
      checked_at: new Date().toISOString(),
      checks: [{ name: 'database', status: 'healthy', message: 'ok', detail: {}, duration_ms: 2 }],
    },
  },
  '/api/shrine/services': { body: { items: [] } },
  '/api/shrine/schema': {
    body: {
      schema: {
        current_version: 6,
        expected_version: 6,
        up_to_date: true,
        pending: [],
        applied: [],
      },
    },
  },
  '/api/shrine/config': { body: config() },
  '/api/shrine/jobs?limit=25': { body: empty },
  '/api/shrine/events?limit=25': { body: empty },
  '/api/shrine/audit?limit=25': { body: empty },
  '/api/shrine/metrics-summary': { body: { metrics: metrics() } },
};

function renderShrine(permissions?: readonly Permission[]) {
  return renderWithProviders(<ShrinePage />, {
    ...(permissions === undefined ? {} : { permissions }),
  });
}

describe('Shrine', () => {
  it('reports each health check individually, not just the overall status', async () => {
    stubFetch(stubs);
    renderShrine();

    const panel = await screen.findByRole('region', { name: 'System health' });
    expect(await within(panel).findByText('database')).toBeInTheDocument();
  });

  it('shows the database it is connected to without any credential', async () => {
    stubFetch(stubs);
    renderShrine();

    const panel = await screen.findByRole('region', { name: 'Configuration' });
    expect(await within(panel).findByText('saga_prod @ db.internal:5432')).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/password|:\/\/.*:.*@/);
  });

  it('warns loudly when the development auth bypass is enabled', async () => {
    stubFetch({ ...stubs, '/api/shrine/config': { body: config({ dev_auth_bypass: true }) } });
    renderShrine();

    expect(
      await screen.findByText(/Development authentication bypass is enabled/),
    ).toBeInTheDocument();
  });

  it('shows a pending migration as pending rather than up to date', async () => {
    stubFetch({
      ...stubs,
      '/api/shrine/schema': {
        body: {
          schema: {
            current_version: 5,
            expected_version: 6,
            up_to_date: false,
            pending: [{ version: 6, name: 'add claims index' }],
            applied: [],
          },
        },
      },
    });
    renderShrine();

    expect(await screen.findByText('migration pending')).toBeInTheDocument();
    expect(screen.getByText(/current 5 \/ expected 6/)).toBeInTheDocument();
  });

  it('requires a reason before retrying a failed job', async () => {
    const { calls } = stubFetch({
      ...stubs,
      '/api/shrine/jobs?limit=25': { body: { ...empty, items: [job()] } },
      [`POST /api/shrine/jobs/${JOB_ID}/retry`]: { body: { job: job({ state: 'queued' }) } },
    });
    renderShrine();

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    const confirm = screen.getByRole('button', { name: 'Confirm retry' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Reason for retry/), 'provider is back');
    await userEvent.click(confirm);

    await waitFor(() => {
      const post = calls.find((call) => call.url.endsWith('/retry'));
      expect(post?.body).toEqual({ reason: 'provider is back' });
    });
  });

  it('offers requeue only for a claimed job whose lease has lapsed', async () => {
    stubFetch({
      ...stubs,
      '/api/shrine/jobs?limit=25': {
        body: {
          ...empty,
          items: [
            job({
              id: 'lapsed',
              state: 'claimed',
              lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
            }),
            job({
              id: 'live',
              state: 'claimed',
              lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            }),
          ],
        },
      },
    });
    renderShrine();

    // A worker still holding a live lease must not have its job taken away underneath it.
    expect(await screen.findAllByRole('button', { name: 'Requeue' })).toHaveLength(1);
  });

  it('offers a viewer no operational action at all', async () => {
    stubFetch({ ...stubs, '/api/shrine/jobs?limit=25': { body: { ...empty, items: [job()] } } });
    renderShrine(VIEWER_PERMISSIONS);

    expect(await screen.findByText('memory_validation')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Queue a probe job' })).not.toBeInTheDocument();
  });

  it('reports a failed panel fetch instead of rendering it as empty', async () => {
    stubFetch({
      ...stubs,
      '/api/shrine/jobs?limit=25': {
        status: 500,
        body: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The job query failed.',
            details: {},
            request_id: 'req_9',
          },
        },
      },
    });
    renderShrine();

    const panel = await screen.findByRole('region', { name: 'Job queue' });
    expect(await within(panel).findByRole('alert')).toHaveTextContent('The job query failed.');
    expect(within(panel).queryByText('The queue is empty')).not.toBeInTheDocument();
  });

  it('explains an empty service list rather than leaving a blank panel', async () => {
    stubFetch(stubs);
    renderShrine();

    expect(await screen.findByText('No service instances registered')).toBeInTheDocument();
  });
});
