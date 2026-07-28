import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { projectSummary, renderWithProviders, stubFetch } from '../test-utils.jsx';
import { ProjectsPage } from './Projects.jsx';

describe('Projects page', () => {
  it('shows a loading state, then the project table', async () => {
    stubFetch({
      '/api/projects': { body: { items: [projectSummary()], next_cursor: null, has_more: false } },
    });
    renderWithProviders(<ProjectsPage />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(await screen.findByRole('link', { name: 'ERP Backoffice' })).toBeInTheDocument();
    const row = screen.getByRole('link', { name: 'ERP Backoffice' }).closest('tr')!;
    expect(within(row).getByText('2 open')).toBeInTheDocument();
    expect(within(row).getByText('rev 3')).toBeInTheDocument();
  });

  it('shows an actionable empty state rather than a blank table', async () => {
    stubFetch({ '/api/projects': { body: { items: [], next_cursor: null, has_more: false } } });
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByText(/saga connect/)).toBeInTheDocument();
  });

  it('surfaces an API failure with its stable error code and a retry affordance', async () => {
    stubFetch({
      '/api/projects': {
        status: 500,
        body: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Database unavailable.',
            details: {},
            request_id: 'req_x',
          },
        },
      },
    });
    renderWithProviders(<ProjectsPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Database unavailable.');
    expect(alert).toHaveTextContent('INTERNAL_ERROR');
    expect(alert).toHaveTextContent('req_x');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('marks a project that still needs its Lore bootstrap', async () => {
    stubFetch({
      '/api/projects': {
        body: {
          items: [
            projectSummary({
              memory_revision: 0,
              active_context_snapshot_id: null,
              bootstrap_required: true,
            }),
          ],
          next_cursor: null,
          has_more: false,
        },
      },
    });
    renderWithProviders(<ProjectsPage />);
    expect(await screen.findByText('needs Lore')).toBeInTheDocument();
  });

  it('sends the CSRF header when creating a project', async () => {
    const created = projectSummary({ name: 'Payment Gateway' });
    const { calls } = stubFetch({
      '/api/projects': { body: { items: [], next_cursor: null, has_more: false } },
      'POST /api/projects': { status: 201, body: { project: created } },
    });
    renderWithProviders(<ProjectsPage />);
    await screen.findByText('No projects yet');

    await userEvent.type(screen.getByLabelText('New project'), 'Payment Gateway');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST');
      expect(post).toBeDefined();
      expect(post!.headers['x-saga-csrf']).toBe('test-csrf-token');
      expect(post!.headers['idempotency-key']).toMatch(/^gh-/);
      expect(post!.body).toEqual({ name: 'Payment Gateway' });
    });
  });

  it('reports a name conflict from the API instead of failing silently', async () => {
    const { calls } = stubFetch({
      '/api/projects': { body: { items: [], next_cursor: null, has_more: false } },
      'POST /api/projects': {
        status: 409,
        body: {
          error: {
            code: 'PROJECT_NAME_CONFLICT',
            message: 'A project named "Payment Gateway" already exists.',
            details: {},
            request_id: 'req_y',
          },
        },
      },
    });
    renderWithProviders(<ProjectsPage />);
    await screen.findByText('No projects yet');

    await userEvent.type(screen.getByLabelText('New project'), 'Payment Gateway');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('keeps the status filter in the URL so the view can be shared', async () => {
    stubFetch({
      '/api/projects': { body: { items: [], next_cursor: null, has_more: false } },
      '/api/projects?status=archived': {
        body: {
          items: [projectSummary({ status: 'archived' })],
          next_cursor: null,
          has_more: false,
        },
      },
    });
    renderWithProviders(<ProjectsPage />);
    await screen.findByText('No projects yet');

    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'archived');
    expect(await screen.findByText('archived')).toBeInTheDocument();
  });

  it('is reachable by keyboard: the create form can be completed without a mouse', async () => {
    stubFetch({
      '/api/projects': { body: { items: [], next_cursor: null, has_more: false } },
      'POST /api/projects': { status: 201, body: { project: projectSummary() } },
    });
    renderWithProviders(<ProjectsPage />);
    await screen.findByText('No projects yet');

    const input = screen.getByLabelText('New project');
    input.focus();
    await userEvent.keyboard('Keyboard Project');
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Create' })).toHaveFocus();
  });
});
