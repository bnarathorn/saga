import { Link } from 'react-router-dom';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Metric,
  Panel,
  RelativeTime,
  StatusPill,
  Table,
} from '../components/primitives.jsx';
import { useEvents, useHealth, useMetrics } from '../lib/queries.js';

export function DashboardPage() {
  const health = useHealth();
  const metrics = useMetrics();
  const events = useEvents('?limit=12');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink-800 dark:text-parchment-100">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
          Saga keeps project knowledge, work continuity and agent coordination in one place.
        </p>
      </div>

      <Panel
        title="System health"
        actions={health.data !== undefined ? <StatusPill status={health.data.status} /> : null}
      >
        {health.isPending && <LoadingState />}
        {health.isError && <ErrorState error={health.error} onRetry={() => void health.refetch()} />}
        {health.data !== undefined && (
          <ul className="divide-y divide-parchment-200/70 dark:divide-night-800/70">
            {health.data.checks.map((check) => (
              <li key={check.name} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <StatusPill status={check.status} />
                <span className="font-mono text-xs text-ink-600 dark:text-parchment-300">
                  {check.name}
                </span>
                <span className="flex-1 text-sm text-ink-600 dark:text-parchment-300/80">
                  {check.message}
                </span>
                <span className="text-xs tabular-nums text-ink-500 dark:text-parchment-300/60">
                  {check.duration_ms}ms
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="At a glance">
        {metrics.isPending && <LoadingState />}
        {metrics.isError && <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} />}
        {metrics.data !== undefined && (
          <div className="grid grid-cols-2 divide-x divide-y divide-parchment-200/70 sm:grid-cols-3 lg:grid-cols-5 dark:divide-night-800/70">
            <Metric label="Projects" value={metrics.data.metrics.projects.active} hint="active" />
            <Metric label="Party members" value={metrics.data.metrics.party.active_agent_runs} hint="live" />
            <Metric label="Open Quests" value={metrics.data.metrics.quest.open} />
            <Metric
              label="Blocked Quests"
              value={metrics.data.metrics.quest.blocked}
              tone={metrics.data.metrics.quest.blocked > 0 ? 'warn' : undefined}
            />
            <Metric
              label="Stale Lore"
              value={metrics.data.metrics.lore.stale}
              tone={metrics.data.metrics.lore.stale > 0 ? 'warn' : undefined}
              hint={`of ${metrics.data.metrics.lore.entries}`}
            />
            <Metric label="Queued jobs" value={metrics.data.metrics.jobs.queued} />
            <Metric
              label="Failed jobs"
              value={metrics.data.metrics.jobs.failed}
              tone={metrics.data.metrics.jobs.failed > 0 ? 'bad' : undefined}
            />
            <Metric
              label="Oldest queued"
              value={
                metrics.data.metrics.jobs.oldest_queued_age_seconds === null
                  ? '—'
                  : `${Math.round(metrics.data.metrics.jobs.oldest_queued_age_seconds)}s`
              }
            />
            <Metric label="Workers live" value={metrics.data.metrics.services.worker_live} />
            <Metric
              label="Outbox pending"
              value={metrics.data.metrics.outbox.pending}
              tone={metrics.data.metrics.outbox.failed > 0 ? 'warn' : undefined}
              hint={metrics.data.metrics.outbox.failed > 0 ? `${metrics.data.metrics.outbox.failed} failed` : undefined}
            />
          </div>
        )}
      </Panel>

      <Panel
        title="Recent activity"
        actions={
          <Link className="link text-sm" to="/shrine">
            Open Shrine
          </Link>
        }
      >
        {events.isPending && <LoadingState />}
        {events.isError && <ErrorState error={events.error} onRetry={() => void events.refetch()} />}
        {events.data?.items.length === 0 && (
          <EmptyState
            title="Nothing has happened yet"
            description="Create a project or connect an agent, and activity will appear here."
          />
        )}
        {events.data !== undefined && events.data.items.length > 0 && (
          <Table headers={['When', 'Severity', 'Event', 'Message']}>
            {events.data.items.map((event) => (
              <tr key={event.id}>
                <td className="table-cell whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
                  <RelativeTime value={event.created_at} />
                </td>
                <td className="table-cell">
                  <Badge
                    tone={
                      event.severity === 'critical' || event.severity === 'error'
                        ? 'bad'
                        : event.severity === 'warning'
                          ? 'warn'
                          : 'neutral'
                    }
                  >
                    {event.severity}
                  </Badge>
                </td>
                <td className="table-cell font-mono text-xs">{event.event_type}</td>
                <td className="table-cell">{event.message}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
