import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders, stubFetch } from '../test-utils.jsx';
import { LorePage } from './Lore.jsx';

const REF = 'ERP%20Backoffice';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    project_id: '00000000-0000-4000-8000-000000000010',
    memory_key: 'run.api.local',
    category: 'running',
    kind: 'procedure',
    state: 'active',
    importance: 80,
    volatility: 'operational',
    current_version: {
      id: '00000000-0000-4000-8000-000000000100',
      memory_item_id: '00000000-0000-4000-8000-000000000001',
      base_version_id: null,
      body: 'Start PostgreSQL and Redis before starting the API.',
      data: {},
      evidence: [],
      content_hash: 'sha256:x',
      confidence: 0.9,
      verification_state: 'observed',
      embedding_state: 'ready',
      embedding_model: 'fake',
      created_at: new Date().toISOString(),
      ready_at: new Date().toISOString(),
    },
    last_verified_at: null,
    stale_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const emptyLists = {
  [`/api/projects/${REF}/lore`]: {
    body: { items: [], next_cursor: null, has_more: false, memory_revision: 0 },
  },
  [`/api/projects/${REF}/lore-updates`]: { body: { items: [] } },
  [`/api/projects/${REF}/context/snapshot`]: { body: { snapshot: null, bootstrap_plan: {} } },
};

/** The page reads `projectRef` from the router, so it is mounted at the matching path. */
function renderLore() {
  return renderWithProviders(<LorePage />, {
    route: `/projects/${REF}/lore`,
    path: '/projects/:projectRef/lore',
  });
}

describe('Lore page', () => {
  it('shows an actionable empty state that mentions the bootstrap flow', async () => {
    stubFetch(emptyLists);
    renderLore();
    expect(await screen.findByText('No Lore recorded yet')).toBeInTheDocument();
    expect(screen.getByText(/saga connect/)).toBeInTheDocument();
  });

  it('lists entries with their state and embedding readiness', async () => {
    stubFetch({
      ...emptyLists,
      [`/api/projects/${REF}/lore`]: {
        body: {
          items: [
            entry(),
            entry({
              id: 'x2',
              memory_key: 'a.pending',
              current_version: { ...entry().current_version, embedding_state: 'queued' },
            }),
          ],
          next_cursor: null,
          has_more: false,
          memory_revision: 4,
        },
      },
    });
    renderLore();

    expect(await screen.findByRole('link', { name: 'run.api.local' })).toBeInTheDocument();
    expect(screen.getByText('revision 4')).toBeInTheDocument();
    expect(screen.getByText('embedding queued')).toBeInTheDocument();
  });

  it('shows the stale reason next to a stale entry', async () => {
    stubFetch({
      ...emptyLists,
      [`/api/projects/${REF}/lore`]: {
        body: {
          items: [entry({ state: 'stale', stale_reason: 'the start command changed' })],
          next_cursor: null,
          has_more: false,
          memory_revision: 4,
        },
      },
    });
    renderLore();
    expect(await screen.findByText('the start command changed')).toBeInTheDocument();
    // "stale" also appears as a filter option, so assert on the badge inside the row.
    const row = screen.getByRole('link', { name: 'run.api.local' }).closest('tr')!;
    expect(within(row).getByText('stale')).toBeInTheDocument();
  });

  it('requires a reason before marking an entry stale', async () => {
    const { calls } = stubFetch({
      ...emptyLists,
      [`/api/projects/${REF}/lore`]: {
        body: { items: [entry()], next_cursor: null, has_more: false, memory_revision: 1 },
      },
      [`POST /api/projects/${REF}/lore/run.api.local/mark-stale`]: {
        body: { entry: entry({ state: 'stale', stale_reason: 'drifted' }) },
      },
    });
    renderLore();

    await userEvent.click(await screen.findByRole('button', { name: 'Mark stale' }));
    const confirm = screen.getAllByRole('button', { name: 'Mark stale' })[1]!;
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/no longer accurate/), 'drifted');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    await waitFor(() => {
      const post = calls.find((call) => call.url.includes('mark-stale'));
      expect(post?.body).toEqual({ reason: 'drifted' });
    });
  });

  it('offers approval controls for a ready update and warns about a conflict', async () => {
    stubFetch({
      ...emptyLists,
      [`/api/projects/${REF}/lore-updates`]: {
        body: {
          items: [
            {
              id: 'u1',
              project_id: 'p1',
              state: 'ready',
              summary: 'Record the integration-test requirements',
              error: null,
              created_at: new Date().toISOString(),
              validating_at: null,
              ready_at: new Date().toISOString(),
              published_at: null,
              cancelled_at: null,
              prepared_snapshot_id: 's1',
              items: [
                {
                  memory_item_id: 'i1',
                  memory_key: 'testing.integration',
                  base_version_id: null,
                  candidate_version_id: 'v1',
                  candidate: entry().current_version,
                  conflicted: true,
                },
              ],
            },
          ],
        },
      },
    });
    renderLore();

    expect(await screen.findByText('Record the integration-test requirements')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve and publish' })).toBeInTheDocument();
    expect(screen.getByText(/changed since this was proposed/)).toBeInTheDocument();
  });

  it('renders search results with the channels that matched', async () => {
    stubFetch({
      ...emptyLists,
      [`POST /api/projects/${REF}/lore/search`]: {
        body: {
          hits: [
            {
              memory_key: 'run.api.local',
              memory_item_id: 'i1',
              category: 'running',
              kind: 'procedure',
              state: 'active',
              importance: 80,
              verification_state: 'observed',
              volatility: 'operational',
              body: 'Start PostgreSQL and Redis before starting the API.',
              data: {},
              evidence_summary: [],
              last_verified_at: null,
              stale_reason: null,
              score: 0.0426,
              matched_by: ['fulltext', 'vector'],
              via_relation: null,
            },
          ],
          mode: 'full',
          warnings: [],
          memory_revision: 1,
        },
      },
    });
    renderLore();
    await screen.findByText('No Lore recorded yet');

    await userEvent.type(screen.getByLabelText(/What do you need to know/), 'start the api');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText(/fulltext \+ vector/)).toBeInTheDocument();
  });

  it('surfaces degraded search rather than pretending results are complete', async () => {
    stubFetch({
      ...emptyLists,
      [`POST /api/projects/${REF}/lore/search`]: {
        body: {
          hits: [],
          mode: 'degraded',
          warnings: [
            'The embedding provider is unavailable, so results come from text search only.',
          ],
          memory_revision: 1,
        },
      },
    });
    renderLore();
    await screen.findByText('No Lore recorded yet');

    await userEvent.type(screen.getByLabelText(/What do you need to know/), 'anything');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText(/embedding provider is unavailable/)).toBeInTheDocument();
  });

  it('warns that a proposal must not contain credentials', async () => {
    stubFetch(emptyLists);
    renderLore();
    await screen.findByText('No Lore recorded yet');

    await userEvent.click(screen.getByRole('button', { name: 'Propose a Lore Entry' }));
    expect(screen.getByText(/Never include credentials/)).toBeInTheDocument();
    expect(screen.getByText(/never changes the current version in place/)).toBeInTheDocument();
  });

  it('reports a rejected proposal with the API message', async () => {
    stubFetch({
      ...emptyLists,
      [`POST /api/projects/${REF}/lore/remember`]: {
        status: 422,
        body: {
          error: {
            code: 'MEMORY_SECRET_DETECTED',
            message: '"config.prod" was rejected because body contains a password.',
            details: {},
            request_id: 'req_z',
          },
        },
      },
    });
    renderLore();
    await screen.findByText('No Lore recorded yet');

    await userEvent.click(screen.getByRole('button', { name: 'Propose a Lore Entry' }));
    await userEvent.type(screen.getByLabelText('Memory key'), 'config.prod');
    await userEvent.type(screen.getByLabelText('Body'), 'DATABASE_URL=postgres://u:p@h/db');
    await userEvent.click(screen.getByRole('button', { name: 'Propose' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('MEMORY_SECRET_DETECTED');
  });

  it('keeps category filters in the URL', async () => {
    stubFetch({
      ...emptyLists,
      [`/api/projects/${REF}/lore?category=warning`]: {
        body: {
          items: [entry({ memory_key: 'warning.migrations', category: 'warning' })],
          next_cursor: null,
          has_more: false,
          memory_revision: 1,
        },
      },
    });
    renderLore();
    await screen.findByText('No Lore recorded yet');

    await userEvent.selectOptions(screen.getByLabelText('Filter by category'), 'warning');
    expect(await screen.findByRole('link', { name: 'warning.migrations' })).toBeInTheDocument();
  });
});
