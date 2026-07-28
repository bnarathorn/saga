import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { adminMe, renderWithProviders, stubFetch } from '../test-utils.jsx';
import { Layout } from './Layout.jsx';

const HEALTH = '/api/shrine/health';

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

function renderShell(route = '/projects') {
  return renderWithProviders(
    <Routes>
      <Route element={<Layout me={adminMe} />}>
        <Route path="/projects" element={<h1>Projects</h1>} />
        <Route path="/shrine" element={<h1>Shrine</h1>} />
      </Route>
    </Routes>,
    { route },
  );
}

describe('the Guild Hall shell', () => {
  it('puts the skip link first in the tab order, ahead of the navigation', async () => {
    stubFetch({ [HEALTH]: health('healthy') });
    const user = userEvent.setup();
    renderShell();

    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  });

  it('reaches every primary destination by keyboard alone', async () => {
    stubFetch({ [HEALTH]: health('healthy') });
    const user = userEvent.setup();
    renderShell();

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(labels).toEqual(['Dashboard', 'Projects', 'Lore', 'Quest Board', 'Party', 'Shrine']);

    // Tab from the skip link into the navigation and follow a link with the keyboard only.
    await user.tab();
    for (let index = 0; index < labels.length; index += 1) await user.tab();
    expect(within(nav).getByRole('link', { name: 'Shrine' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Shrine' })).toBeInTheDocument();
  });

  it('marks the current section for assistive technology, not only by colour', async () => {
    stubFetch({ [HEALTH]: health('healthy') });
    renderShell();

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('shows a degraded API as degraded rather than as healthy', async () => {
    stubFetch({ [HEALTH]: health('degraded') });
    renderShell();

    await waitFor(() =>
      expect(screen.getByText('Degraded', { exact: false })).toBeInTheDocument(),
    );
  });

  it('stays usable when the health endpoint itself fails', async () => {
    stubFetch({
      [HEALTH]: { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'down' } } },
    });
    renderShell();

    // No status pill, but the navigation and the page underneath still render.
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  });
});
