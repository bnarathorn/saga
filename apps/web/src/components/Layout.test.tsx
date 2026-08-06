import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes, useParams } from 'react-router-dom';
import { adminMe, projectSummary, renderWithProviders, stubFetch } from '../test-utils.jsx';
import { Layout } from './Layout.jsx';

const HEALTH = '/api/shrine/health';
const PROJECTS = '/api/projects?limit=200';

function health(status: string) {
  return {
    body: {
      status,
      version: '0.1.0',
      checked_at: new Date().toISOString(),
      checks: [
        {
          name: 'embeddings',
          status,
          message: status === 'healthy' ? 'ok' : 'The embedding provider is not answering.',
          detail: {},
          duration_ms: 3,
        },
      ],
    },
  };
}

const projects = {
  body: {
    items: [
      projectSummary(),
      projectSummary({ id: 'p2', name: 'Retired Thing', status: 'archived' }),
      // A name that is not its own URL encoding, which is what caught the picker decoding an
      // already-decoded route parameter a second time.
      projectSummary({ id: 'p3', name: 'Report 100% Coverage' }),
    ],
    next_cursor: null,
    has_more: false,
  },
};

/** Echoes back what the project route matched, so a navigation is assertable. */
function ProjectStub() {
  const { projectRef = '', '*': rest = '' } = useParams();
  return <h1>{`${projectRef}|${rest}`}</h1>;
}

function renderShell(route = '/projects') {
  return renderWithProviders(
    <Routes>
      <Route element={<Layout me={adminMe} />}>
        <Route path="/" element={<h1>Dashboard</h1>} />
        <Route path="/projects" element={<h1>Projects</h1>} />
        <Route path="/projects/:projectRef/*" element={<ProjectStub />} />
      </Route>
    </Routes>,
    { route },
  );
}

describe('the Guild Hall shell', () => {
  it('puts the skip link first in the tab order, ahead of the navigation', async () => {
    stubFetch({ [HEALTH]: health('healthy'), [PROJECTS]: projects });
    const user = userEvent.setup();
    renderShell();

    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  });

  it('offers exactly two destinations and the project picker', async () => {
    stubFetch({ [HEALTH]: health('healthy'), [PROJECTS]: projects });
    const user = userEvent.setup();
    renderShell();

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(labels).toEqual(['Dashboard', 'Projects']);
    expect(within(nav).getByLabelText('Project')).toBeInTheDocument();

    // Tab from the skip link through both links and into the picker: the whole primary
    // navigation, project switching included, is reachable by keyboard alone.
    await user.tab();
    await user.tab();
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveFocus();
    await user.tab();
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveFocus();
    await user.tab();
    expect(within(nav).getByLabelText('Project')).toHaveFocus();
  });

  it('marks the current section for assistive technology, not only by colour', async () => {
    stubFetch({ [HEALTH]: health('healthy'), [PROJECTS]: projects });
    renderShell();

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens the project chosen in the picker', async () => {
    stubFetch({ [HEALTH]: health('healthy'), [PROJECTS]: projects });
    renderShell();

    await screen.findByRole('option', { name: 'ERP Backoffice' });
    await userEvent.selectOptions(screen.getByLabelText('Project'), 'ERP Backoffice');
    expect(await screen.findByRole('heading', { name: 'ERP Backoffice|' })).toBeInTheDocument();
  });

  it('stays in the same section when the picker switches project', async () => {
    // Comparing two projects' Quest Boards is one control away, not four clicks.
    stubFetch({ [HEALTH]: health('healthy'), [PROJECTS]: projects });
    renderShell('/projects/ERP%20Backoffice/quests');

    const picker = await screen.findByLabelText('Project');
    await waitFor(() => expect(picker).toHaveValue('ERP Backoffice'));

    await userEvent.selectOptions(picker, 'Retired Thing');
    expect(
      await screen.findByRole('heading', { name: 'Retired Thing|quests' }),
    ).toBeInTheDocument();
  });

  it('keeps the section but drops the entity when the picker switches project', async () => {
    // `server.api` is a Lore key of the project being left. Carrying it across would land on
    // the other project's "no such entry", which reads as data loss rather than a switch.
    stubFetch({ [HEALTH]: health('healthy'), [PROJECTS]: projects });
    renderShell('/projects/ERP%20Backoffice/lore/server.api');

    const picker = await screen.findByLabelText('Project');
    await waitFor(() => expect(picker).toHaveValue('ERP Backoffice'));

    await userEvent.selectOptions(picker, 'Retired Thing');
    expect(await screen.findByRole('heading', { name: 'Retired Thing|lore' })).toBeInTheDocument();
  });

  it('survives a project whose name contains a percent sign', async () => {
    // The route parameter arrives decoded. Decoding it again throws `URIError: URI malformed`,
    // and this component sits above the router outlet — so the failure was not a broken picker
    // but a blank console on every page of that project.
    stubFetch({ [HEALTH]: health('healthy'), [PROJECTS]: projects });
    renderShell('/projects/Report%20100%25%20Coverage/lore');

    expect(
      await screen.findByRole('heading', { name: 'Report 100% Coverage|lore' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Project')).toHaveValue('Report 100% Coverage'),
    );
  });

  it('shows a degraded API as degraded rather than as healthy', async () => {
    stubFetch({ [HEALTH]: health('degraded'), [PROJECTS]: projects });
    renderShell();

    await waitFor(() => expect(screen.getByText('Degraded', { exact: false })).toBeInTheDocument());
  });

  it('stays usable when the health endpoint itself fails', async () => {
    stubFetch({
      [HEALTH]: { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'down' } } },
      [PROJECTS]: projects,
    });
    renderShell();

    // No status pill, but the navigation and the page underneath still render.
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  });
});
