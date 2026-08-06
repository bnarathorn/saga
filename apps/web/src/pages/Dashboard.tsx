import type { LatencyDto, MetricsSummaryDto } from '@saga/contracts';
import type { ReactNode } from 'react';
import { AuditLogPanel } from '../components/AuditLogPanel.jsx';
import { JobQueuePanel } from '../components/JobQueuePanel.jsx';
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
import { useCan } from '../lib/permissions.jsx';
import {
  useEvents,
  useHealth,
  useMetrics,
  useSchemaVersion,
  useServices,
  useShrineConfig,
} from '../lib/queries.js';

/**
 * The Dashboard is the *server*: health, service instances, the queue, the schema, the running
 * configuration and everything that is true of the installation rather than of one project.
 *
 * A project's own state lives on its Shrine tab, which the picker in the primary navigation
 * reaches. Nothing here is filtered by project, deliberately — an operator asking "is Saga
 * healthy?" should not have to pick a project first.
 */
export function DashboardPage() {
  const can = useCan();
  const health = useHealth();
  const services = useServices();
  const schema = useSchemaVersion();
  const config = useShrineConfig();
  const metrics = useMetrics();
  const events = useEvents('?limit=25');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink-800 dark:text-parchment-100">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
          This Saga server: health, services, the job queue, schema and configuration.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="System health"
          actions={health.data !== undefined ? <StatusPill status={health.data.status} /> : null}
        >
          {health.isPending && <LoadingState />}
          {health.isError && (
            <ErrorState error={health.error} onRetry={() => void health.refetch()} />
          )}
          {health.data !== undefined && (
            <ul className="divide-y divide-parchment-200/70 dark:divide-night-800/70">
              {health.data.checks.map((check) => (
                <li key={check.name} className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <StatusPill status={check.status} />
                    <span className="font-mono text-xs">{check.name}</span>
                    <span className="ml-auto text-xs tabular-nums text-ink-500 dark:text-parchment-300/60">
                      {check.duration_ms}ms
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-ink-600 dark:text-parchment-300/80">
                    {check.message}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Service instances">
          {services.isPending && <LoadingState />}
          {services.isError && <ErrorState error={services.error} />}
          {services.data?.items.length === 0 && (
            <EmptyState
              title="No service instances registered"
              description="The API and worker register themselves and renew a lease every few seconds."
            />
          )}
          {services.data !== undefined && services.data.items.length > 0 && (
            <Table headers={['Role', 'Instance', 'Version', 'Live', 'Heartbeat']}>
              {services.data.items.map((instance) => (
                <tr key={instance.id}>
                  <td className="table-cell font-medium">{instance.role}</td>
                  <td className="table-cell font-mono text-xs">{instance.instance_key}</td>
                  <td className="table-cell">{instance.version}</td>
                  <td className="table-cell">
                    {/* Liveness comes from the lease, not the stored state column. */}
                    <Badge tone={instance.live ? 'good' : 'bad'}>
                      {instance.live ? 'live' : 'lease expired'}
                    </Badge>
                  </td>
                  <td className="table-cell whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
                    <RelativeTime value={instance.heartbeat_at} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      <Panel title="At a glance">
        {metrics.isPending && <LoadingState />}
        {metrics.isError && (
          <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} />
        )}
        {metrics.data !== undefined && (
          <div className="grid grid-cols-2 divide-x divide-y divide-parchment-200/70 sm:grid-cols-3 lg:grid-cols-5 dark:divide-night-800/70">
            <Metric label="Projects" value={metrics.data.metrics.projects.active} hint="active" />
            <Metric label="Workers live" value={metrics.data.metrics.services.worker_live} />
            <Metric
              label="Party members"
              value={metrics.data.metrics.party.active_agent_runs}
              hint="live"
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
            <Metric
              label="Outbox pending"
              value={metrics.data.metrics.outbox.pending}
              tone={metrics.data.metrics.outbox.failed > 0 ? 'warn' : undefined}
              hint={
                metrics.data.metrics.outbox.failed > 0
                  ? `${metrics.data.metrics.outbox.failed} failed`
                  : undefined
              }
            />
            <Metric label="Stream clients" value={metrics.data.metrics.sse.clients} />
            <Metric
              label="Lore entries"
              value={metrics.data.metrics.lore.entries}
              hint={`${metrics.data.metrics.lore.stale} stale`}
            />
            <Metric label="Open Quests" value={metrics.data.metrics.quest.open} />
          </div>
        )}
      </Panel>

      <JobQueuePanel />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Schema version">
          {schema.isPending && <LoadingState />}
          {schema.isError && (
            <ErrorState error={schema.error} onRetry={() => void schema.refetch()} />
          )}
          {schema.data !== undefined && (
            <div className="space-y-2 px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={schema.data.schema.up_to_date ? 'good' : 'bad'}>
                  {schema.data.schema.up_to_date ? 'up to date' : 'migration pending'}
                </Badge>
                <span className="tabular-nums">
                  current {schema.data.schema.current_version} / expected{' '}
                  {schema.data.schema.expected_version}
                </span>
              </div>
              <ul className="space-y-0.5 font-mono text-xs text-ink-500 dark:text-parchment-300/70">
                {schema.data.schema.applied.map((row) => (
                  <li key={row.version}>
                    {String(row.version).padStart(4, '0')} {row.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel title="Configuration">
          {config.isPending && <LoadingState />}
          {config.isError && (
            <ErrorState error={config.error} onRetry={() => void config.refetch()} />
          )}
          {config.data !== undefined && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
              <ConfigRow label="Version" value={config.data.config.version} />
              <ConfigRow label="Environment" value={config.data.config.node_env} />
              <ConfigRow
                label="Database"
                value={`${config.data.config.database.database} @ ${config.data.config.database.host}`}
              />
              <ConfigRow
                label="TLS"
                value={config.data.config.tls_enabled ? 'enabled' : 'disabled'}
              />
              <ConfigRow
                label="Embeddings"
                value={`${config.data.config.embedding.provider} · ${config.data.config.embedding.model} · ${config.data.config.embedding.dimensions}d`}
              />
              <ConfigRow label="Party mode" value={config.data.config.party_mode} />
              <ConfigRow
                label="Worker"
                value={`${config.data.config.worker.concurrency} concurrent · ${config.data.config.worker.job_lease_seconds}s lease`}
              />
              <ConfigRow
                label="Context budgets"
                value={`core ${config.data.config.context_budgets.core} · task ${config.data.config.context_budgets.task}`}
              />
              {config.data.config.dev_auth_bypass && (
                <div className="col-span-2 mt-2">
                  <p className="rounded border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-xs font-medium text-gold-700 dark:text-gold-400">
                    Development authentication bypass is enabled. Every request is treated as an
                    administrator. Never run this configuration outside local development.
                  </p>
                </div>
              )}
            </dl>
          )}
        </Panel>
      </div>

      {/* Failure and loading are already reported by "At a glance", which reads the same query. */}
      {metrics.data !== undefined && <ThroughputPanels metrics={metrics.data.metrics} />}

      <Panel title="System events">
        {events.isPending && <LoadingState />}
        {events.isError && (
          <ErrorState error={events.error} onRetry={() => void events.refetch()} />
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
                      event.severity === 'error' || event.severity === 'critical'
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
        {events.data?.items.length === 0 && (
          <EmptyState
            title="No events recorded yet"
            description="Create a project or connect an agent, and activity will appear here."
          />
        )}
      </Panel>

      {/* The audit endpoint requires `security:manage`; asking without it buys a 403 and an
          error panel where a viewer should simply see nothing. */}
      {can('security:manage') && <AuditLogPanel />}
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-ink-500 dark:text-parchment-300/70">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </>
  );
}

/**
 * Throughput and latency (spec 18.1).
 *
 * HTTP and in-request latencies are observed by *this* API instance and reset when it
 * restarts, which `since` states plainly. Job latencies come from `shrine.jobs`, so they cover
 * the worker too.
 */
function ThroughputPanels({ metrics }: { metrics: MetricsSummaryDto }) {
  const errors = Object.entries(metrics.http.errors_by_code).sort((a, b) => b[1] - a[1]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Throughput">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 text-sm">
          <ConfigRow label="Requests" value={metrics.http.requests.toLocaleString()} />
          <ConfigRow label="Request p95" value={`${String(metrics.http.duration.p95_ms)} ms`} />
          <ConfigRow label="Searches" value={metrics.search.total.toLocaleString()} />
          <ConfigRow
            label="Search fallback"
            value={`${metrics.search.vector_fallback.toLocaleString()} text-only`}
          />
          <ConfigRow label="Contexts built" value={metrics.context.builds.toLocaleString()} />
          <ConfigRow label="Context tokens" value={metrics.context.tokens_total.toLocaleString()} />
          <ConfigRow
            label="Worker heartbeat age"
            value={
              metrics.heartbeat_age_seconds.worker === null
                ? 'never'
                : `${String(Math.round(metrics.heartbeat_age_seconds.worker))} s`
            }
          />
          <ConfigRow label="Counting since" value={<RelativeTime value={metrics.http.since} />} />

          <div className="col-span-2">
            <p className="field-label">Errors by code</p>
            {errors.length === 0 ? (
              <p className="text-xs text-ink-500 dark:text-parchment-300/60">
                No errors since this instance started.
              </p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-2">
                {errors.map(([code, count]) => (
                  <li key={code}>
                    <Badge tone={code === 'NOT_FOUND' ? 'neutral' : 'warn'}>
                      {code} · {count}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </dl>
      </Panel>

      <Panel title="Latency">
        <Table headers={['Operation', 'Count', 'Mean', 'p95', 'Max']}>
          <LatencyRow label="HTTP request" latency={metrics.http.duration} />
          {/* Auto-mode publishes run inside the validation job, so they are counted there. */}
          <LatencyRow label="Lore publish (approval)" latency={metrics.latency.lore_publish} />
          <LatencyRow label="Lore search" latency={metrics.latency.lore_search} />
          <LatencyRow label="Context build" latency={metrics.latency.context_build} />
          <LatencyRow
            label="Lore validate + publish (job)"
            latency={metrics.latency.memory_validation}
          />
          <LatencyRow label="Snapshot build (job)" latency={metrics.latency.context_snapshot} />
          <LatencyRow label="Embedding (job)" latency={metrics.latency.embedding} />
        </Table>
      </Panel>
    </div>
  );
}

function LatencyRow({ label, latency }: { label: string; latency: LatencyDto }) {
  return (
    <tr>
      <td className="table-cell">{label}</td>
      <td className="table-cell tabular-nums">{latency.count.toLocaleString()}</td>
      <td className="table-cell tabular-nums">{Math.round(latency.mean_ms)} ms</td>
      <td className="table-cell tabular-nums">{Math.round(latency.p95_ms)} ms</td>
      <td className="table-cell tabular-nums">{Math.round(latency.max_ms)} ms</td>
    </tr>
  );
}
