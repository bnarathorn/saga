import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders, stubFetch } from '../test-utils.jsx';
import { QuestBoardPage } from './QuestBoard.jsx';

const REF = 'ERP%20Backoffice';
const LIST = `/api/projects/${REF}/quests?limit=200`;

let counter = 0;

function quest(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    project_id: '00000000-0000-4000-8000-000000000010',
    parent_work_item_id: null,
    title: 'Add CSV report export',
    objective: null,
    status: 'in_progress',
    priority: 'normal',
    scope: {},
    revision: 2,
    latest_checkpoint_id: null,
    created_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    completed_at: null,
    archived_at: null,
    ...overrides,
  };
}

function renderBoard() {
  return renderWithProviders(<QuestBoardPage />, {
    route: `/projects/${REF}/quests`,
    path: '/projects/:projectRef/quests',
  });
}

describe('Quest Board', () => {
  it('shows an empty state explaining where Quests come from', async () => {
    stubFetch({ [LIST]: { body: { items: [], next_cursor: null, has_more: false } } });
    renderBoard();
    expect(await screen.findByText('No Quests yet')).toBeInTheDocument();
    expect(screen.getByText(/created automatically when an agent session/)).toBeInTheDocument();
  });

  it('renders all five documented columns', async () => {
    stubFetch({ [LIST]: { body: { items: [quest()], next_cursor: null, has_more: false } } });
    renderBoard();
    await screen.findByText('Add CSV report export');
    for (const title of ['Open', 'In Progress', 'Waiting', 'Blocked', 'Completed']) {
      expect(screen.getByRole('region', { name: `${title} Quests` })).toBeInTheDocument();
    }
  });

  it('places each Quest in its status column', async () => {
    stubFetch({
      [LIST]: {
        body: {
          items: [
            quest({ title: 'Blocked work', status: 'blocked' }),
            quest({ title: 'Open work', status: 'open' }),
          ],
          next_cursor: null,
          has_more: false,
        },
      },
    });
    renderBoard();
    await screen.findByText('Blocked work');

    const blocked = screen.getByRole('region', { name: 'Blocked Quests' });
    expect(within(blocked).getByText('Blocked work')).toBeInTheDocument();
    const open = screen.getByRole('region', { name: 'Open Quests' });
    expect(within(open).getByText('Open work')).toBeInTheDocument();
  });

  it('shows cancelled Quests alongside completed ones rather than hiding them', async () => {
    stubFetch({
      [LIST]: {
        body: {
          items: [quest({ title: 'Dropped work', status: 'cancelled' })],
          next_cursor: null,
          has_more: false,
        },
      },
    });
    renderBoard();
    const completed = await screen.findByRole('region', { name: 'Completed Quests' });
    expect(within(completed).getByText('Dropped work')).toBeInTheDocument();
    expect(within(completed).getByText('cancelled')).toBeInTheDocument();
  });

  it('shows the revision and priority on each card', async () => {
    stubFetch({
      [LIST]: {
        body: {
          items: [quest({ priority: 'critical', revision: 7 })],
          next_cursor: null,
          has_more: false,
        },
      },
    });
    renderBoard();
    expect(await screen.findByText('critical')).toBeInTheDocument();
    expect(screen.getByText('rev 7')).toBeInTheDocument();
  });

  it('creates a Quest with a CSRF header and an idempotency key', async () => {
    const { calls } = stubFetch({
      [LIST]: { body: { items: [], next_cursor: null, has_more: false } },
      [`POST /api/projects/${REF}/quests`]: { status: 201, body: { quest: quest() } },
    });
    renderBoard();
    await screen.findByText('No Quests yet');

    await userEvent.type(screen.getByLabelText('New Quest'), 'Add CSV report export');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST');
      expect(post?.headers['x-saga-csrf']).toBe('test-csrf-token');
      expect(post?.headers['idempotency-key']).toMatch(/^gh-/);
      expect(post?.body).toEqual({ title: 'Add CSV report export' });
    });
  });

  it('reports a rejected creation instead of failing silently', async () => {
    stubFetch({
      [LIST]: { body: { items: [], next_cursor: null, has_more: false } },
      [`POST /api/projects/${REF}/quests`]: {
        status: 422,
        body: {
          error: {
            code: 'PROJECT_ARCHIVED',
            message: 'The project is archived and is read-only.',
            details: {},
            request_id: 'req_a',
          },
        },
      },
    });
    renderBoard();
    await screen.findByText('No Quests yet');

    await userEvent.type(screen.getByLabelText('New Quest'), 'Anything');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('PROJECT_ARCHIVED');
  });
});
