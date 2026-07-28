import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  RelativeTime,
  Table,
} from '../components/primitives.jsx';
import { ApiError } from '../lib/api.js';
import { useCan } from '../lib/permissions.jsx';
import { useCreateProject, useProjects } from '../lib/queries.js';

export function ProjectsPage() {
  // Filters live in the URL so a filtered view can be shared or bookmarked.
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const search = searchParams.get('q') ?? '';

  const query = new URLSearchParams();
  if (status.length > 0) query.set('status', status);
  if (search.length > 0) query.set('q', search);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  const can = useCan();
  const projects = useProjects(suffix);
  const create = useCreateProject();
  const [name, setName] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length === 0) return;
    create.mutate({ name }, { onSuccess: () => setName('') });
  };

  const createError = create.error instanceof ApiError ? create.error : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-800 dark:text-parchment-100">
            Projects
          </h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
            A project is identified by its name. Renaming keeps its identity and its history.
          </p>
        </div>

        {can('project:write') && (
        <form onSubmit={submit} className="flex items-end gap-2">
          <div>
            <label className="field-label" htmlFor="new-project">
              New project
            </label>
            <input
              id="new-project"
              className="field-input w-64"
              value={name}
              placeholder="ERP Backoffice"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </form>
        )}
      </div>

      {createError !== null && (
        <p role="alert" className="text-sm font-medium text-rust-600 dark:text-rust-400">
          {createError.message}
        </p>
      )}

      <Panel
        title="All projects"
        actions={
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="filter-search">
              Search projects
            </label>
            <input
              id="filter-search"
              className="field-input w-44 py-1 text-xs"
              placeholder="Search…"
              value={search}
              onChange={(event) => {
                const next = new URLSearchParams(searchParams);
                if (event.target.value.length === 0) next.delete('q');
                else next.set('q', event.target.value);
                setSearchParams(next, { replace: true });
              }}
            />
            <label className="sr-only" htmlFor="filter-status">
              Filter by status
            </label>
            <select
              id="filter-status"
              className="field-input w-32 py-1 text-xs"
              value={status}
              onChange={(event) => {
                const next = new URLSearchParams(searchParams);
                if (event.target.value.length === 0) next.delete('status');
                else next.set('status', event.target.value);
                setSearchParams(next, { replace: true });
              }}
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        }
      >
        {projects.isPending && <LoadingState />}
        {projects.isError && <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />}
        {projects.data?.items.length === 0 && (
          <EmptyState
            title="No projects yet"
            description="Create one above, then run `saga connect` in a project folder to bind it."
          />
        )}
        {projects.data !== undefined && projects.data.items.length > 0 && (
          <Table
            headers={['Project', 'Lore', 'Quests', 'Party', 'Jobs', 'Last activity', 'State']}
          >
            {projects.data.items.map((project) => (
              <tr key={project.id} className="hover:bg-parchment-100/60 dark:hover:bg-night-800/40">
                <td className="table-cell">
                  <Link className="link" to={`/projects/${encodeURIComponent(project.name)}`}>
                    {project.name}
                  </Link>
                  {project.aliases.length > 0 && (
                    <span className="ml-2 text-xs text-ink-500 dark:text-parchment-300/60">
                      was {project.aliases.join(', ')}
                    </span>
                  )}
                </td>
                <td className="table-cell tabular-nums">
                  {project.stats.lore_entry_count}
                  {project.stats.stale_lore_count > 0 && (
                    <span className="ml-2">
                      <Badge tone="warn">{project.stats.stale_lore_count} stale</Badge>
                    </span>
                  )}
                </td>
                <td className="table-cell tabular-nums">
                  {project.stats.open_quest_count} open
                  {project.stats.blocked_quest_count > 0 && (
                    <span className="ml-2">
                      <Badge tone="bad">{project.stats.blocked_quest_count} blocked</Badge>
                    </span>
                  )}
                </td>
                <td className="table-cell tabular-nums">{project.stats.active_agent_count}</td>
                <td className="table-cell tabular-nums">
                  {project.stats.failed_job_count > 0 ? (
                    <Badge tone="bad">{project.stats.failed_job_count} failed</Badge>
                  ) : (
                    <span className="text-ink-500 dark:text-parchment-300/60">—</span>
                  )}
                </td>
                <td className="table-cell whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
                  <RelativeTime value={project.stats.last_activity_at} />
                </td>
                <td className="table-cell">
                  {project.status === 'archived' ? (
                    <Badge tone="neutral">archived</Badge>
                  ) : project.bootstrap_required ? (
                    <Badge tone="warn">needs Lore</Badge>
                  ) : (
                    <Badge tone="good">rev {project.memory_revision}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
