import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  projectSummary,
  renderWithProviders,
  stubFetch,
  VIEWER_PERMISSIONS,
} from '../test-utils.jsx';
import { ProjectActivity } from './ProjectActivity.jsx';
import { ProjectRelations } from './ProjectRelations.jsx';

const REF = 'ERP%20Backoffice';
const PROJECT_ID = '00000000-0000-4000-8000-000000000010';
const LINKS = `/api/projects/${REF}/lore-links`;
const ENTRIES = `/api/projects/${REF}/lore?limit=200`;
const PROJECT = `/api/projects/${REF}`;

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    from_memory_key: 'server.api',
    relation: 'uses',
    to_memory_key: 'database.primary',
    metadata: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function entry(memoryKey: string) {
  return {
    memory_key: memoryKey,
    memory_item_id: `00000000-0000-4000-8000-0000000000${memoryKey.length}0`,
    project_id: PROJECT_ID,
    category: 'server',
    kind: 'entity',
    state: 'active',
    importance: 50,
    volatility: 'stable',
    current_version: null,
    last_verified_at: null,
    stale_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    sequence: 12,
    severity: 'info',
    category: 'quest',
    project_id: PROJECT_ID,
    entity_type: 'work_item',
    entity_id: null,
    event_type: 'quest.checkpoint_created',
    message: 'Checkpoint recorded for "Add CSV report export" (milestone).',
    metadata: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function renderRelations(permissions?: readonly string[]) {
  return renderWithProviders(<ProjectRelations />, {
    route: `/projects/${REF}/relations`,
    path: '/projects/:projectRef/relations',
    ...(permissions === undefined ? {} : { permissions: permissions as never }),
  });
}

function renderActivity() {
  return renderWithProviders(<ProjectActivity />, {
    route: `/projects/${REF}/activity`,
    path: '/projects/:projectRef/activity',
  });
}

describe('the Relations tab', () => {
  it('lists the relation graph with both endpoints linked', async () => {
    stubFetch({
      [LINKS]: { body: { items: [link()] } },
      [ENTRIES]: {
        body: { items: [entry('server.api'), entry('database.primary')], next_cursor: null },
      },
    });
    renderRelations();

    const row = (await screen.findByRole('link', { name: 'server.api' })).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('uses')).toBeInTheDocument();
    expect(within(row!).getByRole('link', { name: 'database.primary' })).toHaveAttribute(
      'href',
      `/projects/${REF}/lore/database.primary`,
    );
  });

  it('explains the empty graph instead of showing a bare table', async () => {
    stubFetch({
      [LINKS]: { body: { items: [] } },
      [ENTRIES]: { body: { items: [], next_cursor: null } },
    });
    renderRelations();

    expect(await screen.findByText('No relations recorded')).toBeInTheDocument();
  });

  it('offers relation editing to an operator and withholds it from a viewer', async () => {
    stubFetch({
      [LINKS]: { body: { items: [link()] } },
      [ENTRIES]: { body: { items: [entry('server.api')], next_cursor: null } },
    });
    renderRelations(VIEWER_PERMISSIONS);

    await screen.findByRole('link', { name: 'server.api' });
    expect(screen.queryByRole('button', { name: 'Add relation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('posts a new relation built from the project’s own entries', async () => {
    const { calls } = stubFetch({
      [LINKS]: { body: { items: [] } },
      [ENTRIES]: {
        body: { items: [entry('server.api'), entry('database.primary')], next_cursor: null },
      },
      [`POST ${LINKS}`]: { status: 201, body: { link: link() } },
    });
    renderRelations();

    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('From'), 'server.api');
    await user.selectOptions(screen.getByLabelText('Relation'), 'uses');
    await user.selectOptions(screen.getByLabelText('To'), 'database.primary');
    await user.click(screen.getByRole('button', { name: 'Add relation' }));

    const posted = calls.find((call) => call.method === 'POST');
    expect(posted?.body).toEqual({
      from_memory_key: 'server.api',
      relation: 'uses',
      to_memory_key: 'database.primary',
    });
  });

  it('refuses a self-link before it reaches the API', async () => {
    stubFetch({
      [LINKS]: { body: { items: [] } },
      [ENTRIES]: { body: { items: [entry('server.api')], next_cursor: null } },
    });
    renderRelations();

    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('From'), 'server.api');
    await user.selectOptions(screen.getByLabelText('To'), 'server.api');

    expect(screen.getByText('An entry cannot relate to itself.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add relation' })).toBeDisabled();
  });
});

describe('the Activity tab', () => {
  const activityUrl = (category?: string) =>
    `/api/shrine/events?limit=100&project_id=${PROJECT_ID}${
      category === undefined ? '' : `&category=${category}`
    }`;

  it('shows this project’s events, newest first', async () => {
    stubFetch({
      [PROJECT]: { body: { project: projectSummary() } },
      [activityUrl()]: {
        body: { items: [event()], next_cursor: null, has_more: false },
      },
    });
    renderActivity();

    expect(
      await screen.findByText('Checkpoint recorded for "Add CSV report export" (milestone).'),
    ).toBeInTheDocument();
    expect(screen.getByText('quest.checkpoint_created')).toBeInTheDocument();
  });

  it('scopes the request to the project uuid, never the display name', async () => {
    const { calls } = stubFetch({
      [PROJECT]: { body: { project: projectSummary() } },
      [activityUrl()]: { body: { items: [event()], next_cursor: null, has_more: false } },
    });
    renderActivity();

    await screen.findByText('quest.checkpoint_created');
    expect(calls.some((call) => call.url.includes(`project_id=${PROJECT_ID}`))).toBe(true);
  });

  it('never asks for the unfiltered, server-wide feed while the project id is loading', async () => {
    // The query string depends on the project UUID, which resolves a render late. An ungated
    // query would spend that render fetching every project's events.
    const { calls } = stubFetch({
      [PROJECT]: { body: { project: projectSummary() } },
      '/api/shrine/events': { body: { items: [], next_cursor: null, has_more: false } },
      [activityUrl()]: { body: { items: [event()], next_cursor: null, has_more: false } },
    });
    renderActivity();

    await screen.findByText('quest.checkpoint_created');
    expect(calls.map((call) => call.url)).not.toContain('/api/shrine/events');
  });

  it('filters by domain', async () => {
    const { calls } = stubFetch({
      [PROJECT]: { body: { project: projectSummary() } },
      [activityUrl()]: { body: { items: [event()], next_cursor: null, has_more: false } },
      [activityUrl('lore')]: {
        body: {
          items: [event({ category: 'lore', event_type: 'lore.memory_published' })],
          next_cursor: null,
          has_more: false,
        },
      },
    });
    renderActivity();

    await screen.findByText('quest.checkpoint_created');
    await userEvent.setup().selectOptions(screen.getByLabelText('Domain'), 'lore');

    expect(await screen.findByText('lore.memory_published')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('&category=lore'))).toBe(true);
  });

  it('surfaces a failed project lookup instead of spinning forever', async () => {
    // The events query stays disabled while the project id is unknown, and a disabled query
    // never leaves `isPending` — so this only works if errors are checked before pending.
    stubFetch({
      [PROJECT]: {
        status: 404,
        body: { error: { code: 'PROJECT_NOT_FOUND', message: 'No such project.', details: {} } },
      },
    });
    renderActivity();

    expect(await screen.findByText('No such project.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('Loading activity…')).not.toBeInTheDocument();
  });

  it('explains the empty feed', async () => {
    stubFetch({
      [PROJECT]: { body: { project: projectSummary() } },
      [activityUrl()]: { body: { items: [], next_cursor: null, has_more: false } },
    });
    renderActivity();

    expect(await screen.findByText('Nothing has happened yet')).toBeInTheDocument();
  });
});
