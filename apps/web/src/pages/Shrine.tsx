import { Link, useParams } from 'react-router-dom';
import { AuditLogPanel } from '../components/AuditLogPanel.jsx';
import { JobQueuePanel } from '../components/JobQueuePanel.jsx';
import {
  Badge,
  ErrorState,
  LoadingState,
  Metric,
  Panel,
  RelativeTime,
} from '../components/primitives.jsx';
import { useCan } from '../lib/permissions.jsx';
import { useProject } from '../lib/queries.js';

/**
 * The Shrine of one project: its operational state, not the server's.
 *
 * The Dashboard answers "is Saga healthy?"; this answers "is *this project* in good order?" —
 * whether its context is compiled, what its Lore, Quests and Party add up to, which of its jobs
 * are stuck, and what an administrator has done to it.
 */
export function ShrinePage() {
  const can = useCan();
  const { projectRef = '' } = useParams();
  const project = useProject(projectRef);

  if (project.isError)
    return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  if (project.data === undefined) return <LoadingState label="Loading project state…" />;

  const data = project.data.project;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-ink-800 dark:text-parchment-100">
          Shrine
        </h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
          This project&rsquo;s operational state: context, workload and its own jobs. The{' '}
          <Link className="link" to="/">
            Dashboard
          </Link>{' '}
          covers the server itself.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Context"
          actions={
            <Badge tone={data.bootstrap_required ? 'warn' : 'good'}>
              {data.bootstrap_required ? 'bootstrap required' : 'compiled'}
            </Badge>
          }
        >
          <div className="space-y-3 px-4 py-3 text-sm">
            {data.bootstrap_required ? (
              <div className="rounded border border-gold-500/40 bg-gold-500/10 px-3 py-2">
                <p className="font-medium text-gold-700 dark:text-gold-400">
                  No active context snapshot
                </p>
                <p className="mt-1 text-ink-600 dark:text-parchment-300/80">
                  Run <code className="font-mono text-xs">saga connect</code> in the project folder
                  and let the agent propose initial Lore from local evidence.
                </p>
              </div>
            ) : (
              <p className="text-ink-600 dark:text-parchment-300/80">
                Core context is compiled and ready for new agent sessions.
              </p>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <dt className="text-ink-500 dark:text-parchment-300/70">Lore revision</dt>
              <dd className="tabular-nums">{data.memory_revision}</dd>
              <dt className="text-ink-500 dark:text-parchment-300/70">Active snapshot</dt>
              <dd className="font-mono text-xs">{data.active_context_snapshot_id ?? 'none'}</dd>
              <dt className="text-ink-500 dark:text-parchment-300/70">Approval mode</dt>
              <dd>{data.lore_approval_mode}</dd>
              <dt className="text-ink-500 dark:text-parchment-300/70">Lifecycle</dt>
              <dd>{data.status}</dd>
              <dt className="text-ink-500 dark:text-parchment-300/70">Last activity</dt>
              <dd>
                <RelativeTime value={data.stats.last_activity_at} />
              </dd>
            </dl>
          </div>
        </Panel>

        <Panel
          title="Workload"
          actions={
            <Link
              className="link text-sm"
              to={`/projects/${encodeURIComponent(projectRef)}/activity`}
            >
              Full activity
            </Link>
          }
        >
          <div className="grid grid-cols-2 divide-x divide-y divide-parchment-200/70 dark:divide-night-800/70">
            <Metric label="Lore entries" value={data.stats.lore_entry_count} />
            <Metric
              label="Stale Lore"
              value={data.stats.stale_lore_count}
              tone={data.stats.stale_lore_count > 0 ? 'warn' : undefined}
            />
            <Metric label="Open Quests" value={data.stats.open_quest_count} />
            <Metric
              label="Blocked Quests"
              value={data.stats.blocked_quest_count}
              tone={data.stats.blocked_quest_count > 0 ? 'bad' : undefined}
            />
            <Metric label="Party members" value={data.stats.active_agent_count} hint="active" />
            <Metric
              label="Failed jobs"
              value={data.stats.failed_job_count}
              tone={data.stats.failed_job_count > 0 ? 'bad' : undefined}
            />
          </div>
        </Panel>
      </div>

      {/* Scoped by UUID, never by the display name: a rename must not change what is listed. */}
      <JobQueuePanel projectId={data.id} />

      {/* The audit endpoint requires `security:manage`; asking without it buys a 403 and an
          error panel where a viewer should simply see nothing. */}
      {can('security:manage') && <AuditLogPanel projectId={data.id} />}
    </div>
  );
}
