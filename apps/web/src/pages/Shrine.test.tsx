import type { Permission } from '@saga/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  projectSummary,
  renderWithProviders,
  stubFetch,
  VIEWER_PERMISSIONS,
} from '../test-utils.jsx';
import { ShrinePage } from './Shrine.jsx';

const REF = 'ERP%20Backoffice';
const PROJECT = `/api/projects/${REF}`;
const PROJECT_ID = '00000000-0000-4000-8000-000000000010';
const JOBS = `/api/shrine/jobs?limit=25&project_id=${PROJECT_ID}`;
const AUDIT = `/api/shrine/audit?limit=25&project_id=${PROJECT_ID}`;
const JOB_ID = '00000000-0000-4000-8000-000000000700';

const empty = { items: [], next_cursor: null, has_more: false };

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    project_id: PROJECT_ID,
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

const stubs = {
  [PROJECT]: { body: { project: projectSummary() } },
  [JOBS]: { body: empty },
  [AUDIT]: { body: empty },
};

function renderShrine(permissions?: readonly Permission[]) {
  return renderWithProviders(<ShrinePage />, {
    route: `/projects/${REF}/shrine`,
    path: '/projects/:projectRef/shrine',
    ...(permissions === undefined ? {} : { permissions }),
  });
}

describe('a project’s Shrine', () => {
  it('reports this project’s state, not the server’s', async () => {
    stubFetch(stubs);
    renderShrine();

    const context = await screen.findByRole('region', { name: 'Context' });
    expect(within(context).getByText('compiled')).toBeInTheDocument();
    expect(within(context).getByText('auto')).toBeInTheDocument();

    const workload = screen.getByRole('region', { name: 'Workload' });
    expect(within(workload).getByText('12')).toBeInTheDocument();
    // Nothing on this page describes the installation: no schema, config or service instances.
    expect(screen.queryByRole('region', { name: 'Configuration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Service instances' })).not.toBeInTheDocument();
  });

  it('names the bootstrap that is missing rather than reporting the project as ready', async () => {
    stubFetch({
      ...stubs,
      [PROJECT]: {
        body: {
          project: projectSummary({
            bootstrap_required: true,
            active_context_snapshot_id: null,
            memory_revision: 0,
          }),
        },
      },
    });
    renderShrine();

    expect(await screen.findByText('No active context snapshot')).toBeInTheDocument();
    expect(screen.getByText(/saga connect/)).toBeInTheDocument();
  });

  it('scopes the job queue to the project uuid, never the display name', async () => {
    const { calls } = stubFetch({ ...stubs, [JOBS]: { body: { ...empty, items: [job()] } } });
    renderShrine();

    expect(await screen.findByText('memory_validation')).toBeInTheDocument();
    // A rename must not change which jobs are listed, so the name never reaches the query.
    expect(calls.some((call) => call.url === JOBS)).toBe(true);
    expect(calls.some((call) => call.url === '/api/shrine/jobs?limit=25')).toBe(false);
  });

  it('never asks for the server-wide queue while the project id is loading', async () => {
    // The query string depends on the project UUID, which resolves a render late. An ungated
    // query would spend that render fetching every project's jobs.
    const { calls } = stubFetch({
      ...stubs,
      '/api/shrine/jobs?limit=25': { body: empty },
      [JOBS]: { body: { ...empty, items: [job()] } },
    });
    renderShrine();

    await screen.findByText('memory_validation');
    expect(calls.map((call) => call.url)).not.toContain('/api/shrine/jobs?limit=25');
  });

  it('retries one of this project’s failed jobs, with the reason the audit log records', async () => {
    const { calls } = stubFetch({
      ...stubs,
      [JOBS]: { body: { ...empty, items: [job()] } },
      [`POST /api/shrine/jobs/${JOB_ID}/retry`]: { body: { job: job({ state: 'queued' }) } },
    });
    renderShrine();

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await userEvent.type(screen.getByLabelText(/Reason for retry/), 'provider is back');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm retry' }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.endsWith('/retry'));
      expect(post?.body).toEqual({ reason: 'provider is back' });
    });
  });

  it('enqueues a probe against this project, not the server at large', async () => {
    const { calls } = stubFetch({
      ...stubs,
      'POST /api/shrine/jobs/probe': { status: 201, body: { job: job({ state: 'queued' }) } },
    });
    renderShrine();

    await userEvent.click(await screen.findByRole('button', { name: 'Queue a probe job' }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.endsWith('/probe'));
      expect(post?.body).toEqual({ echo: 'Guild Hall probe', project_id: PROJECT_ID });
    });
  });

  it('scopes the audit log to this project, and withholds it from a viewer', async () => {
    const { calls } = stubFetch(stubs);
    renderShrine(VIEWER_PERMISSIONS);

    await screen.findByRole('region', { name: 'Context' });
    expect(screen.queryByRole('region', { name: 'Audit log' })).not.toBeInTheDocument();
    expect(calls.some((call) => call.url.startsWith('/api/shrine/audit'))).toBe(false);
  });

  it('surfaces a failed project lookup instead of spinning forever', async () => {
    stubFetch({
      [PROJECT]: {
        status: 404,
        body: { error: { code: 'PROJECT_NOT_FOUND', message: 'No such project.', details: {} } },
      },
    });
    renderShrine();

    expect(await screen.findByText('No such project.')).toBeInTheDocument();
    expect(screen.queryByText('Loading project state…')).not.toBeInTheDocument();
  });
});
