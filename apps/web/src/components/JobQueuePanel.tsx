import type { JobDto } from '@saga/contracts';
import { JOB_STATES, JOB_TYPES } from '@saga/contracts/constants';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCan } from '../lib/permissions.jsx';
import { useJobAction, useJobs, useProbeJob } from '../lib/queries.js';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  RelativeTime,
  Table,
  type BadgeTone,
} from './primitives.jsx';

/**
 * A URL value is only passed to the API when it is one the API accepts. A hand-edited or stale
 * link would otherwise turn the panel into a 400 instead of a job list.
 */
function allowedParam<T extends string>(value: string | null, allowed: readonly T[]): T | '' {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : '';
}

const JOB_STATE_TONE: Record<string, BadgeTone> = {
  queued: 'neutral',
  claimed: 'info',
  retrying: 'warn',
  succeeded: 'good',
  failed: 'bad',
  cancelled: 'neutral',
};

/**
 * The job queue, server-wide on the Dashboard and scoped to one project on its Shrine.
 *
 * `projectId` is the only difference between the two: the filters, the operator actions and
 * the audit-reason prompt are identical, because a job is the same object either way.
 */
export function JobQueuePanel({ projectId }: { projectId?: string }) {
  const can = useCan();
  const [searchParams, setSearchParams] = useSearchParams();
  const probe = useProbeJob();

  // The recurring jobs — `session_reaper` and `party_reaper` every five minutes, `cleanup`
  // hourly — outnumber everything else, so the newest 25 rows are otherwise almost all
  // periodic ticks and real work never reaches the first page.
  const jobType = allowedParam(searchParams.get('job_type'), JOB_TYPES);
  const jobState = allowedParam(searchParams.get('state'), JOB_STATES);
  const query = new URLSearchParams({ limit: '25' });
  if (jobType !== '') query.set('job_type', jobType);
  if (jobState !== '') query.set('state', jobState);
  if (projectId !== undefined) query.set('project_id', projectId);
  const jobs = useJobs(`?${query.toString()}`);
  const filtered = jobType !== '' || jobState !== '';

  const setFilter = (key: 'job_type' | 'state', value: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  return (
    <Panel
      title="Job queue"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="filter-job-type">
            Filter by job type
          </label>
          <select
            id="filter-job-type"
            className="field-input w-44 py-1 text-xs"
            value={jobType}
            onChange={(event) => setFilter('job_type', event.target.value)}
          >
            <option value="">All job types</option>
            {JOB_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="filter-job-state">
            Filter by job state
          </label>
          <select
            id="filter-job-state"
            className="field-input w-32 py-1 text-xs"
            value={jobState}
            onChange={(event) => setFilter('state', event.target.value)}
          >
            <option value="">All states</option>
            {JOB_STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
          {/* The probe is the only job Guild Hall can enqueue: there is no arbitrary payload
              editor and no command runner here, by design. */}
          {can('shrine:operate') && (
            <button
              type="button"
              className="btn-secondary"
              disabled={probe.isPending}
              onClick={() =>
                probe.mutate({
                  echo: 'Guild Hall probe',
                  ...(projectId === undefined ? {} : { project_id: projectId }),
                })
              }
            >
              {probe.isPending ? 'Queueing…' : 'Queue a probe job'}
            </button>
          )}
        </div>
      }
    >
      {jobs.isPending && <LoadingState />}
      {jobs.isError && <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />}
      {jobs.data?.items.length === 0 &&
        (filtered ? (
          <EmptyState
            title="No jobs match this filter"
            description="Nothing in the retained history has that type and state. Clear the filter to see the whole queue."
          />
        ) : projectId === undefined ? (
          <EmptyState
            title="The queue is empty"
            description="Queue a probe job to confirm the worker is draining the queue."
          />
        ) : (
          <EmptyState
            title="No jobs for this project"
            description="Validation, embedding and snapshot jobs appear here as agents publish Lore and record checkpoints."
          />
        ))}
      {jobs.data !== undefined && jobs.data.items.length > 0 && (
        <Table headers={['Type', 'State', 'Attempts', 'Created', 'Last error', 'Actions']}>
          {jobs.data.items.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </Table>
      )}
    </Panel>
  );
}

function JobRow({ job }: { job: JobDto }) {
  const can = useCan();
  const retry = useJobAction('retry');
  const cancel = useJobAction('cancel');
  const requeue = useJobAction('requeue');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState<null | 'retry' | 'cancel' | 'requeue'>(null);

  const operate = can('shrine:operate');
  const canRetry = operate && (job.state === 'failed' || job.state === 'cancelled');
  const canCancel = operate && (job.state === 'queued' || job.state === 'retrying');
  const canRequeue =
    operate &&
    job.state === 'claimed' &&
    job.lease_expires_at !== null &&
    new Date(job.lease_expires_at).getTime() < Date.now();

  const pending = retry.isPending || cancel.isPending || requeue.isPending;

  const run = () => {
    if (open === null || reason.trim().length === 0 || pending) return;
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
              <button
                type="button"
                className="btn-secondary py-1 text-xs"
                onClick={() => setOpen('retry')}
              >
                Retry
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                className="btn-secondary py-1 text-xs"
                onClick={() => setOpen('cancel')}
              >
                Cancel
              </button>
            )}
            {canRequeue && (
              <button
                type="button"
                className="btn-secondary py-1 text-xs"
                onClick={() => setOpen('requeue')}
              >
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
              {/* An idempotency key only helps a client that retries with the *same* key;
                  a second click is a second decision. Disabling while in flight is what
                  actually stops one operator action becoming two audit records. */}
              <button
                type="button"
                className="btn-primary"
                disabled={reason.trim().length === 0 || pending}
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
