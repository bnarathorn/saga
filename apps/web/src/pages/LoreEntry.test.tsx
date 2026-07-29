import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders, stubFetch } from '../test-utils.jsx';
import { LoreEntryPage } from './LoreEntry.jsx';

const REF = 'ERP%20Backoffice';
const KEY = 'run.api.local';
const DETAIL = `/api/projects/${REF}/lore/${KEY}`;
const VERSIONS = `${DETAIL}/versions`;

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000100',
    memory_item_id: '00000000-0000-4000-8000-000000000001',
    base_version_id: null,
    body: 'Start PostgreSQL and Redis before starting the API.',
    data: {},
    evidence: [],
    content_hash: 'sha256:abc',
    confidence: 0.92,
    verification_state: 'observed',
    embedding_state: 'ready',
    embedding_model: 'fake',
    created_at: new Date().toISOString(),
    ready_at: new Date().toISOString(),
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    project_id: '00000000-0000-4000-8000-000000000010',
    memory_key: KEY,
    category: 'running',
    kind: 'procedure',
    state: 'active',
    importance: 80,
    volatility: 'operational',
    current_version: version(),
    last_verified_at: null,
    stale_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const stubs = {
  [DETAIL]: { body: { entry: entry(), links: [] } },
  [VERSIONS]: {
    body: { items: [version()], current_version_id: '00000000-0000-4000-8000-000000000100' },
  },
};

function renderEntry() {
  return renderWithProviders(<LoreEntryPage />, {
    route: `/projects/${REF}/lore/${KEY}`,
    path: '/projects/:projectRef/lore/:memoryKey',
  });
}

describe('Lore entry detail', () => {
  it('shows the current body, confidence and verification state', async () => {
    stubFetch(stubs);
    renderEntry();

    expect(await screen.findByText(/Start PostgreSQL and Redis/)).toBeInTheDocument();
    expect(screen.getByText('importance 80')).toBeInTheDocument();

    // "observed" also appears in the version history below, so assert on the metadata panel.
    const metadata = screen.getByRole('region', { name: 'Metadata' });
    expect(within(metadata).getByText('observed')).toBeInTheDocument();
    expect(within(metadata).getByText('0.92')).toBeInTheDocument();
  });

  it('labels a stale entry with the reason it was marked stale', async () => {
    stubFetch({
      ...stubs,
      [DETAIL]: {
        body: {
          entry: entry({ state: 'stale', stale_reason: 'the start command changed' }),
          links: [],
        },
      },
    });
    renderEntry();

    expect(await screen.findByText(/Marked stale: the start command changed/)).toBeInTheDocument();
  });

  it('renders structured data and evidence when the version carries them', async () => {
    stubFetch({
      ...stubs,
      [DETAIL]: {
        body: {
          entry: entry({
            current_version: version({
              data: { port: 4319 },
              evidence: [{ path: 'docker-compose.yml', content_hash: 'sha256:0123456789abcdef' }],
            }),
          }),
          links: [],
        },
      },
    });
    renderEntry();

    expect(await screen.findByText('Structured data')).toBeInTheDocument();
    expect(screen.getByText(/"port": 4319/)).toBeInTheDocument();
    expect(screen.getByText(/docker-compose\.yml/)).toBeInTheDocument();
  });

  it('explains an entry whose candidate has not been published yet', async () => {
    stubFetch({
      ...stubs,
      [DETAIL]: { body: { entry: entry({ current_version: null }), links: [] } },
      [VERSIONS]: { body: { items: [], current_version_id: null } },
    });
    renderEntry();

    expect(await screen.findByText(/still in the proposal pipeline/)).toBeInTheDocument();
  });

  it('links both endpoints of every relation', async () => {
    stubFetch({
      ...stubs,
      [DETAIL]: {
        body: {
          entry: entry(),
          links: [
            {
              id: 'l1',
              project_id: '00000000-0000-4000-8000-000000000010',
              from_memory_key: KEY,
              relation: 'depends_on',
              to_memory_key: 'config.database',
              created_at: new Date().toISOString(),
            },
          ],
        },
      },
    });
    renderEntry();

    const panel = await screen.findByRole('region', { name: 'Relations' });
    expect(within(panel).getByRole('link', { name: KEY })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'config.database' })).toBeInTheDocument();
  });

  it('marks which version in the history is the current one', async () => {
    stubFetch({
      ...stubs,
      [VERSIONS]: {
        body: {
          items: [
            version(),
            version({ id: '00000000-0000-4000-8000-000000000101', confidence: 0.5 }),
          ],
          current_version_id: '00000000-0000-4000-8000-000000000100',
        },
      },
    });
    renderEntry();

    const panel = await screen.findByRole('region', { name: 'Version history' });
    const current = await within(panel).findByText('current');
    expect(current.closest('tr')).toHaveTextContent('00000000');
  });

  it('reports a failed fetch rather than an empty entry', async () => {
    stubFetch({
      ...stubs,
      [DETAIL]: {
        status: 404,
        body: {
          error: {
            code: 'MEMORY_ITEM_NOT_FOUND',
            message: 'No Lore entry has that key.',
            details: {},
            request_id: 'req_3',
          },
        },
      },
    });
    renderEntry();

    expect(await screen.findByRole('alert')).toHaveTextContent('No Lore entry has that key.');
  });
});
