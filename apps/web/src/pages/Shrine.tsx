import type { JobDto } from '@saga/contracts';
import { useState } from 'react';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  RelativeTime,
  StatusPill,
  Table,
  type BadgeTone,
} from '../components/primitives.jsx';
import {
  useAuditLog,
  useEvents,
  useHealth,
  useJobAction,
  useJobs,
  useProbeJob,
  useSchemaVersion,
  useServices,
  useShrineConfig,
} from '../lib/queries.js';

const JOB_STATE_TONE: Record<string, BadgeTone> = {
  queued: 'neutral',
  claimed: 'info',
  retrying: 'warn',
  succeeded: 'good',
  failed: 'bad',
  cancelled: 'neutral',
};

export function ShrinePage() {
  const health = useHealth();
  const services = useServices();
  const schema = useSchemaVersion();
  const config = useShrineConfig();
  const jobs = useJobs('?limit=25');
  const events = useEvents('?limit=25');
  const audit = useAuditLog('?limit=25');
  const probe = useProbeJob();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink-800 dark:text-parchment-100">
          Shrine
        </h1>
        <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
          Saga&rsquo;s own operational state: services, jobs, schema and events.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="System health"
          actions={health.data !== undefined ? <StatusPill status={health.data.status} /> : null}
        >
          {health.isPending && <LoadingState />}
          {health.isError && <ErrorState error={health.error} onRetry={() => void health.refetch()} />}
          {health.data !== undefined && (
            <ul className="divide-y divide-parchment-200/70 dark:divide-night-800/70">
              {health.data.checks.map((check) => (
                <li key={check.name} className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <StatusPill status={check.status} />
                    <span className="font-mono text-xs">{check.name}</span>
                  </div>
                  <p className="mt-1 text-sm text-ink-600 dark:text-parchment-300/80">{check.message}</p>
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

      <Panel
        title="Job queue"
        actions={
          <button
            type="button"
            className="btn-secondary"
            disabled={probe.isPending}
            onClick={() => probe.mutate({ echo: 'Guild Hall probe' })}
          >
            {probe.isPending ? 'Queueing…' : 'Queue a probe job'}
          </button>
        }
      >
        {jobs.isPending && <LoadingState />}
        {jobs.isError && <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />}
        {jobs.data?.items.length === 0 && (
          <EmptyState
            title="The queue is empty"
            description="Queue a probe job to confirm the worker is draining the queue."
          />
        )}
        {jobs.data !== undefined && jobs.data.items.length > 0 && (
          <Table headers={['Type', 'State', 'Attempts', 'Created', 'Last error', 'Actions']}>
            {jobs.data.items.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </Table>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Schema version">
          {schema.isPending && <LoadingState />}
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
          {config.data !== undefined && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
              <ConfigRow label="Version" value={config.data.config.version} />
              <ConfigRow label="Environment" value={config.data.config.node_env} />
              <ConfigRow
                label="Database"
                value={`${config.data.config.database.database} @ ${config.data.config.database.host}`}
              />
              <ConfigRow label="TLS" value={config.data.config.tls_enabled ? 'enabled' : 'disabled'} />
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

      <Panel title="System events">
        {events.isPending && <LoadingState />}
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
        {events.data?.items.length === 0 && <EmptyState title="No events recorded yet" />}
      </Panel>

      <Panel title="Audit log">
        {audit.isPending && <LoadingState />}
        {audit.isError && <ErrorState error={audit.error} />}
        {audit.data !== undefined && audit.data.items.length > 0 && (
          <Table headers={['When', 'Actor', 'Action', 'Reason']}>
            {audit.data.items.map((entry) => (
              <tr key={entry.id}>
                <td className="table-cell whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
                  <RelativeTime value={entry.created_at} />
                </td>
                <td className="table-cell">{entry.actor_label ?? entry.actor_type}</td>
                <td className="table-cell font-mono text-xs">{entry.action}</td>
                <td className="table-cell text-ink-600 dark:text-parchment-300/80">
                  {entry.reason ?? '—'}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {audit.data?.items.length === 0 && <EmptyState title="No administrative actions recorded" />}
      </Panel>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-500 dark:text-parchment-300/70">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </>
  );
}

function JobRow({ job }: { job: JobDto }) {
  const retry = useJobAction('retry');
  const cancel = useJobAction('cancel');
  const requeue = useJobAction('requeue');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState<null | 'retry' | 'cancel' | 'requeue'>(null);

  const canRetry = job.state === 'failed' || job.state === 'cancelled';
  const canCancel = job.state === 'queued' || job.state === 'retrying';
  const canRequeue =
    job.state === 'claimed' &&
    job.lease_expires_at !== null &&
    new Date(job.lease_expires_at).getTime() < Date.now();

  const run = () => {
    if (open === null || reason.trim().length === 0) return;
    const payload = { id: job.id, reason };
    const mutation = open === 'retry' ? retry : open === 'cancel' ? cancel : requeue;
    mutation.mutate(payload, {
      onSuccess: () => {
        setOpen(null);
        setReason('');
      },
    });
  };

  return (
    <>
      <tr>
        <td className="table-cell font-mono text-xs">{job.job_type}</td>
        <td className="table-cell">
          <Badge tone={JOB_STATE_TONE[job.state] ?? 'neutral'}>{job.state}</Badge>
        </td>
        <td className="table-cell tabular-nums">
          {job.attempts}/{job.max_attempts}
        </td>
        <td className="table-cell whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
          <RelativeTime value={job.created_at} />
        </td>
        <td className="table-cell max-w-xs truncate text-xs text-rust-600 dark:text-rust-400">
          {job.last_error ?? '—'}
        </td>
        <td className="table-cell">
          <div className="flex gap-1">
            {canRetry && (
              <button type="button" className="btn-secondary py-1 text-xs" onClick={() => setOpen('retry')}>
                Retry
              </button>
            )}
            {canCancel && (
              <button type="button" className="btn-secondary py-1 text-xs" onClick={() => setOpen('cancel')}>
                Cancel
              </button>
            )}
            {canRequeue && (
              <button type="button" className="btn-secondary py-1 text-xs" onClick={() => setOpen('requeue')}>
                Requeue
              </button>
            )}
            {!canRetry && !canCancel && !canRequeue && (
              <span className="text-xs text-ink-500 dark:text-parchment-300/60">—</span>
            )}
          </div>
        </td>
      </tr>
      {open !== null && (
        <tr className="bg-parchment-100/70 dark:bg-night-850/70">
          <td colSpan={6} className="px-4 py-3">
            {/* Every disruptive action is confirmed and requires a reason for the audit log. */}
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1">
                <label className="field-label" htmlFor={`reason-${job.id}`}>
                  Reason for {open} (recorded in the audit log)
                </label>
                <input
                  id={`reason-${job.id}`}
                  className="field-input"
                  value={reason}
                  autoFocus
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={reason.trim().length === 0}
                onClick={run}
              >
                Confirm {open}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setOpen(null)}>
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
