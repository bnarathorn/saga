import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  projectSummary,
  renderWithProviders,
  stubFetch,
  VIEWER_PERMISSIONS,
} from '../test-utils.jsx';
import { LorePage } from './Lore.jsx';
import { ProjectsPage } from './Projects.jsx';
import { QuestBoardPage } from './QuestBoard.jsx';

/**
 * Permission-based action visibility. The API refuses these actions independently — this
 * suite is about not offering a control that would only produce a 403.
 */

const REF = 'ERP%20Backoffice';

const loreStubs = {
  [`/api/projects/${REF}/lore`]: {
    body: { items: [], next_cursor: null, has_more: false, memory_revision: 0 },
  },
  [`/api/projects/${REF}/lore-updates`]: {
    body: {
      items: [
        {
          id: '00000000-0000-4000-8000-000000000200',
          project_id: '00000000-0000-4000-8000-000000000010',
          state: 'ready',
          summary: 'Record run.api.local',
          source: 'agent',
          error: null,
          created_at: new Date().toISOString(),
          items: [{ memory_key: 'run.api.local', operation: 'upsert', conflicted: false }],
        },
      ],
    },
  },
  [`/api/projects/${REF}/context/snapshot`]: { body: { snapshot: null, bootstrap_plan: {} } },
};

describe('permission-based action visibility', () => {
  it('offers project creation to an operator', async () => {
    stubFetch({ '/api/projects': { body: { items: [], next_cursor: null, has_more: false } } });
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('hides project creation from a viewer', async () => {
    stubFetch({
      '/api/projects': { body: { items: [projectSummary()], next_cursor: null, has_more: false } },
    });
    renderWithProviders(<ProjectsPage />, { permissions: VIEWER_PERMISSIONS });

    // The list itself is still fully visible: a viewer reads everything.
    expect(await screen.findByRole('link', { name: 'ERP Backoffice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New project')).not.toBeInTheDocument();
  });

  it('hides proposing and publishing Lore from a viewer', async () => {
    stubFetch(loreStubs);
    renderWithProviders(<LorePage />, {
      route: `/projects/${REF}/lore`,
      path: '/projects/:projectRef/lore',
      permissions: VIEWER_PERMISSIONS,
    });

    // The pending update is still shown — a viewer can see that a change is waiting.
    expect(await screen.findByText('Record run.api.local')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and publish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose a Lore Entry' })).not.toBeInTheDocument();
  });

  it('hides Lore lifecycle actions from a viewer', async () => {
    stubFetch({
      ...loreStubs,
      [`/api/projects/${REF}/lore`]: {
        body: {
          items: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              project_id: '00000000-0000-4000-8000-000000000010',
              memory_key: 'run.api.local',
              category: 'running',
              kind: 'procedure',
              state: 'active',
              importance: 80,
              volatility: 'operational',
              current_version: null,
              last_verified_at: null,
              stale_reason: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          next_cursor: null,
          has_more: false,
          memory_revision: 1,
        },
      },
    });
    renderWithProviders(<LorePage />, {
      route: `/projects/${REF}/lore`,
      path: '/projects/:projectRef/lore',
      permissions: VIEWER_PERMISSIONS,
    });

    expect(await screen.findByRole('link', { name: 'run.api.local' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark stale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('offers publishing to an operator', async () => {
    stubFetch(loreStubs);
    renderWithProviders(<LorePage />, {
      route: `/projects/${REF}/lore`,
      path: '/projects/:projectRef/lore',
    });

    expect(await screen.findByRole('button', { name: 'Approve and publish' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propose a Lore Entry' })).toBeInTheDocument();
  });

  it('hides Quest creation from a viewer', async () => {
    stubFetch({
      [`/api/projects/${REF}/quests?limit=200`]: {
        body: { items: [], next_cursor: null, has_more: false },
      },
    });
    renderWithProviders(<QuestBoardPage />, {
      route: `/projects/${REF}/quests`,
      path: '/projects/:projectRef/quests',
      permissions: VIEWER_PERMISSIONS,
    });

    expect(await screen.findByText('No Quests yet')).toBeInTheDocument();
    expect(screen.queryByLabelText('New Quest')).not.toBeInTheDocument();
  });
});
