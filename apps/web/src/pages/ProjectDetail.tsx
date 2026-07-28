import { useEffect, useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import {
  Badge,
  ErrorState,
  LoadingState,
  Panel,
  RelativeTime,
  classNames,
} from '../components/primitives.jsx';
import { ApiError } from '../lib/api.js';
import { useCan } from '../lib/permissions.jsx';
import { rememberProject } from '../lib/last-project.js';
import { useProject, useProjectLifecycle, useRenameProject } from '../lib/queries.js';

const TABS = [
  { to: '', label: 'Overview', end: true },
  { to: 'lore', label: 'Lore', end: false },
  { to: 'quests', label: 'Quest Board', end: false },
  { to: 'party', label: 'Party', end: false },
  { to: 'relations', label: 'Relations', end: false },
  { to: 'activity', label: 'Activity', end: false },
];

export function ProjectDetailPage() {
  const { projectRef = '' } = useParams();
  const project = useProject(projectRef);
  // The top-level Lore/Quest Board/Party entries need a project to act on (spec 1).
  useEffect(() => rememberProject(projectRef), [projectRef]);

  if (project.isPending) return <LoadingState label="Loading project…" />;
  if (project.isError) {
    const error = project.error;
    if (error instanceof ApiError && error.status === 404) {
      return (
        <Panel title="Project not found">
          <div className="px-4 py-8 text-sm text-ink-600 dark:text-parchment-300/80">
            No project matches <code className="font-mono">{projectRef}</code>. It may have been
            renamed — try the current name, or look it up on the Projects page.
          </div>
        </Panel>
      );
    }
    return <ErrorState error={error} onRetry={() => void project.refetch()} />;
  }

  const data = project.data.project;

  return (
    <div className="space-y-6">
      <ProjectHeader projectRef={projectRef} />

      <nav
        aria-label="Project sections"
        className="border-b border-parchment-300 dark:border-night-800"
      >
        <ul className="-mb-px flex flex-wrap gap-1">
          {TABS.map((tab) => (
            <li key={tab.label}>
              <NavLink
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  classNames(
                    'block border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'border-ember-500 text-ink-800 dark:text-parchment-100'
                      : 'border-transparent text-ink-500 hover:text-ink-700 dark:text-parchment-300/70 dark:hover:text-parchment-100',
                  )
                }
              >
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <Outlet context={data} />
    </div>
  );
}

function ProjectHeader({ projectRef }: { projectRef: string }) {
  const can = useCan();
  const project = useProject(projectRef);
  const rename = useRenameProject();
  const archive = useProjectLifecycle('archive');
  const restore = useProjectLifecycle('restore');
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [lifecycleReason, setLifecycleReason] = useState<string | null>(null);

  if (project.data === undefined) return null;
  const data = project.data.project;

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-2xl font-semibold text-ink-800 dark:text-parchment-100">
              {data.name}
            </h1>
            {data.status === 'archived' && <Badge tone="neutral">archived</Badge>}
            <Badge tone={data.bootstrap_required ? 'warn' : 'good'}>
              Lore revision {data.memory_revision}
            </Badge>
          </div>
          {data.aliases.length > 0 && (
            <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">
              Previously known as {data.aliases.join(', ')} — both names still resolve.
            </p>
          )}
          {data.description !== null && (
            <p className="mt-1 max-w-prose text-sm text-ink-600 dark:text-parchment-300/80">
              {data.description}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {can('project:write') && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setNewName(data.name);
                setRenaming(true);
              }}
            >
              Rename
            </button>
          )}
          {can('project:archive') &&
            (data.status === 'active' ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setLifecycleReason('')}
              >
                Archive
              </button>
            ) : (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setLifecycleReason('')}
              >
                Restore
              </button>
            ))}
        </div>
      </div>

      {renaming && (
        <Panel title="Rename project">
          <div className="flex flex-wrap items-end gap-2 px-4 py-3">
            <div className="flex-1">
              <label className="field-label" htmlFor="rename-input">
                New name
              </label>
              <input
                id="rename-input"
                className="field-input"
                value={newName}
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
              />
              <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">
                The project keeps its identity and history. The old name is preserved as an alias.
              </p>
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={rename.isPending || newName.trim().length === 0}
              onClick={() =>
                rename.mutate(
                  { ref: data.id, name: newName },
                  { onSuccess: () => setRenaming(false) },
                )
              }
            >
              Save
            </button>
            <button type="button" className="btn-secondary" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </div>
          {rename.error !== null && <ErrorState error={rename.error} />}
        </Panel>
      )}

      {lifecycleReason !== null && (
        <Panel title={data.status === 'active' ? 'Archive project' : 'Restore project'}>
          <div className="flex flex-wrap items-end gap-2 px-4 py-3">
            <div className="flex-1">
              <label className="field-label" htmlFor="lifecycle-reason">
                Reason (recorded in the audit log)
              </label>
              <input
                id="lifecycle-reason"
                className="field-input"
                value={lifecycleReason}
                autoFocus
                onChange={(event) => setLifecycleReason(event.target.value)}
              />
              {data.status === 'active' && (
                <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">
                  Archiving makes the project read-only. Nothing is deleted, and it can be restored.
                </p>
              )}
            </div>
            <button
              type="button"
              className={data.status === 'active' ? 'btn-danger' : 'btn-primary'}
              disabled={lifecycleReason.trim().length === 0}
              onClick={() => {
                const mutation = data.status === 'active' ? archive : restore;
                mutation.mutate(
                  { ref: data.id, reason: lifecycleReason },
                  { onSuccess: () => setLifecycleReason(null) },
                );
              }}
            >
              Confirm
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setLifecycleReason(null)}
            >
              Cancel
            </button>
          </div>
        </Panel>
      )}
    </header>
  );
}

/** Overview tab. Later phases add Lore, Quest and Party detail alongside it. */
export function ProjectOverview() {
  const { projectRef = '' } = useParams();
  const project = useProject(projectRef);
  if (project.data === undefined) return <LoadingState />;
  const data = project.data.project;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Summary">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-sm">
          <dt className="text-ink-500 dark:text-parchment-300/70">Identifier</dt>
          <dd className="font-mono text-xs">{data.id}</dd>
          <dt className="text-ink-500 dark:text-parchment-300/70">Lore revision</dt>
          <dd className="tabular-nums">{data.memory_revision}</dd>
          <dt className="text-ink-500 dark:text-parchment-300/70">Active snapshot</dt>
          <dd className="font-mono text-xs">
            {data.active_context_snapshot_id ?? 'none — bootstrap required'}
          </dd>
          <dt className="text-ink-500 dark:text-parchment-300/70">Approval mode</dt>
          <dd>{data.lore_approval_mode}</dd>
          <dt className="text-ink-500 dark:text-parchment-300/70">Created</dt>
          <dd>
            <RelativeTime value={data.created_at} />
          </dd>
          <dt className="text-ink-500 dark:text-parchment-300/70">Last activity</dt>
          <dd>
            <RelativeTime value={data.stats.last_activity_at} />
          </dd>
        </dl>
      </Panel>

      <Panel title="State">
        <div className="space-y-3 px-4 py-3 text-sm">
          {data.bootstrap_required ? (
            <div className="rounded border border-gold-500/40 bg-gold-500/10 px-3 py-2">
              <p className="font-medium text-gold-700 dark:text-gold-400">
                Lore bootstrap required
              </p>
              <p className="mt-1 text-ink-600 dark:text-parchment-300/80">
                This project has no active context snapshot yet. Run{' '}
                <code className="font-mono text-xs">saga connect</code> in the project folder and
                let the agent propose initial Lore from local evidence.
              </p>
            </div>
          ) : (
            <p className="text-ink-600 dark:text-parchment-300/80">
              Core context is compiled and ready for new agent sessions.
            </p>
          )}

          <ul className="space-y-1">
            <li>
              {data.stats.lore_entry_count} Lore{' '}
              {data.stats.lore_entry_count === 1 ? 'entry' : 'entries'}
              {data.stats.stale_lore_count > 0 && (
                <span className="ml-2">
                  <Badge tone="warn">{data.stats.stale_lore_count} stale</Badge>
                </span>
              )}
            </li>
            <li>
              {data.stats.open_quest_count} open{' '}
              {data.stats.open_quest_count === 1 ? 'Quest' : 'Quests'}
              {data.stats.blocked_quest_count > 0 && (
                <span className="ml-2">
                  <Badge tone="bad">{data.stats.blocked_quest_count} blocked</Badge>
                </span>
              )}
            </li>
            <li>{data.stats.active_agent_count} active Party members</li>
            {data.stats.failed_job_count > 0 && (
              <li>
                <Badge tone="bad">{data.stats.failed_job_count} failed jobs</Badge>
              </li>
            )}
          </ul>
        </div>
      </Panel>
    </div>
  );
}
