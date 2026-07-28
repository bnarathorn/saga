import type { CheckpointDto, QuestStatus } from '@saga/contracts';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  RelativeTime,
  Table,
  type BadgeTone,
} from '../components/primitives.jsx';
import { useQuestDetail, useQuestLifecycle, useUpdateQuest } from '../lib/quest-queries.js';
import { useCan } from '../lib/permissions.jsx';

const STATUS_TONE: Record<QuestStatus, BadgeTone> = {
  open: 'neutral',
  in_progress: 'info',
  waiting: 'warn',
  blocked: 'bad',
  completed: 'good',
  cancelled: 'neutral',
};

const STATUSES: QuestStatus[] = [
  'open',
  'in_progress',
  'waiting',
  'blocked',
  'completed',
  'cancelled',
];

export function QuestDetailPage() {
  const can = useCan();
  const { projectRef = '', questId = '' } = useParams();
  const detail = useQuestDetail(questId);
  const update = useUpdateQuest();
  const reopen = useQuestLifecycle('reopen');
  const [reopenReason, setReopenReason] = useState<string | null>(null);

  if (detail.isPending) return <LoadingState label="Loading Quest…" />;
  if (detail.isError)
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;

  const {
    quest,
    children,
    dependencies,
    checkpoints,
    sessions,
    latest_handoff: handoff,
  } = detail.data;
  const closed = quest.status === 'completed' || quest.status === 'cancelled';

  return (
    <div className="space-y-6">
      <div>
        <Link className="link text-sm" to={`/projects/${encodeURIComponent(projectRef)}/quests`}>
          ← Quest Board
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="font-display text-xl font-semibold text-ink-800 dark:text-parchment-100">
            {quest.title}
          </h2>
          <Badge tone={STATUS_TONE[quest.status]}>{quest.status}</Badge>
          <Badge tone="neutral">{quest.priority}</Badge>
          <span className="text-xs text-ink-500 dark:text-parchment-300/70">
            revision {quest.revision}
          </span>
        </div>
        {quest.objective !== null && (
          <p className="mt-2 max-w-prose text-sm text-ink-600 dark:text-parchment-300/80">
            {quest.objective}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {can('quest:write') && (
            <>
              <label className="sr-only" htmlFor="quest-status">
                Change status
              </label>
              <select
                id="quest-status"
                className="field-input w-40 py-1 text-xs"
                value={quest.status}
                disabled={update.isPending}
                onChange={(event) =>
                  update.mutate({ questId, status: event.target.value as QuestStatus })
                }
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              {closed && (
                <button type="button" className="btn-secondary" onClick={() => setReopenReason('')}>
                  Reopen
                </button>
              )}
            </>
          )}
        </div>
        {update.isError && <ErrorState error={update.error} />}
      </div>

      {reopenReason !== null && (
        <Panel title="Reopen this Quest">
          <div className="flex flex-wrap items-end gap-2 px-4 py-3">
            <div className="flex-1">
              <label className="field-label" htmlFor="reopen-reason">
                Reason (recorded in the audit log)
              </label>
              <input
                id="reopen-reason"
                className="field-input"
                autoFocus
                value={reopenReason}
                onChange={(event) => setReopenReason(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={reopenReason.trim().length === 0}
              onClick={() =>
                reopen.mutate(
                  { questId, reason: reopenReason },
                  { onSuccess: () => setReopenReason(null) },
                )
              }
            >
              Confirm reopen
            </button>
            <button type="button" className="btn-secondary" onClick={() => setReopenReason(null)}>
              Cancel
            </button>
          </div>
        </Panel>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {handoff !== null && <HandoffPanel handoff={handoff} />}

          <Panel title="Checkpoint history">
            {checkpoints.length === 0 ? (
              <EmptyState
                title="No checkpoints yet"
                description="An agent records a checkpoint at each milestone and before context compaction."
              />
            ) : (
              <ul className="divide-y divide-parchment-200/70 dark:divide-night-800/70">
                {checkpoints.map((checkpoint) => (
                  <li key={checkpoint.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={checkpoint.kind === 'final_handoff' ? 'good' : 'neutral'}>
                        {checkpoint.kind}
                      </Badge>
                      <span className="text-sm font-medium">{checkpoint.summary}</span>
                      <span className="text-xs text-ink-500 dark:text-parchment-300/60">
                        rev {checkpoint.base_work_item_revision} →{' '}
                        {checkpoint.base_work_item_revision + 1} ·{' '}
                        <RelativeTime value={checkpoint.created_at} />
                      </span>
                    </div>
                    <WorkStateSummary state={checkpoint.work_state} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Scope">
            {Object.keys(quest.scope).length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-500 dark:text-parchment-300/70">
                No scope declared. Party uses declared scope to warn about overlapping work.
              </p>
            ) : (
              <dl className="space-y-2 px-4 py-3 text-sm">
                {Object.entries(quest.scope).map(([field, values]) => (
                  <div key={field}>
                    <dt className="metric-label">{field.replace('_', ' ')}</dt>
                    <dd className="mt-0.5 font-mono text-xs text-ink-600 dark:text-parchment-300/80">
                      {(values as string[]).join(', ')}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>

          {children.length > 0 && (
            <Panel title="Questline">
              <ul className="divide-y divide-parchment-200/70 px-4 dark:divide-night-800/70">
                {children.map((child) => (
                  <li key={child.id} className="py-2">
                    <Link
                      className="link text-sm"
                      to={`/projects/${encodeURIComponent(projectRef)}/quests/${child.id}`}
                    >
                      {child.title}
                    </Link>
                    <span className="ml-2">
                      <Badge tone={STATUS_TONE[child.status]}>{child.status}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {dependencies.length > 0 && (
            <Panel title="Dependencies">
              <ul className="divide-y divide-parchment-200/70 px-4 dark:divide-night-800/70">
                {dependencies.map((dependency) => (
                  <li key={dependency.depends_on_work_item_id} className="py-2 text-sm">
                    <span className="text-xs text-ink-500 dark:text-parchment-300/60">
                      {dependency.dependency_type}
                    </span>{' '}
                    <Link
                      className="link"
                      to={`/projects/${encodeURIComponent(projectRef)}/quests/${dependency.depends_on_work_item_id}`}
                    >
                      {dependency.depends_on_title}
                    </Link>
                    <span className="ml-2">
                      <Badge tone={STATUS_TONE[dependency.depends_on_status]}>
                        {dependency.depends_on_status}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="Sessions">
            {sessions.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-500 dark:text-parchment-300/70">
                No sessions have worked on this Quest yet.
              </p>
            ) : (
              <Table headers={['Client', 'Mode', 'State', 'Started']}>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="table-cell text-xs">
                      {session.client}
                      {session.workspace_label !== null && (
                        <span className="ml-1 text-ink-500 dark:text-parchment-300/60">
                          ({session.workspace_label})
                        </span>
                      )}
                    </td>
                    <td className="table-cell text-xs">{session.activation_mode ?? '—'}</td>
                    <td className="table-cell">
                      <Badge
                        tone={
                          session.state === 'active'
                            ? 'info'
                            : session.state === 'abandoned'
                              ? 'warn'
                              : 'neutral'
                        }
                      >
                        {session.state}
                      </Badge>
                    </td>
                    <td className="table-cell whitespace-nowrap text-xs text-ink-500 dark:text-parchment-300/70">
                      <RelativeTime value={session.started_at} />
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function HandoffPanel({ handoff }: { handoff: CheckpointDto }) {
  const state = handoff.work_state;
  return (
    <Panel
      title="Latest handoff"
      actions={
        <span className="text-xs text-ink-500 dark:text-parchment-300/70">
          <RelativeTime value={handoff.created_at} />
        </span>
      }
    >
      <div className="space-y-3 px-4 py-3 text-sm">
        <p className="font-medium">{handoff.summary}</p>
        <p className="text-ink-600 dark:text-parchment-300/80">
          <span className="metric-label">Goal</span> — {state.goal}
        </p>

        {state.next_steps.length > 0 && <ListBlock title="Next steps" items={state.next_steps} />}
        {state.blockers.length > 0 && (
          <div>
            <h4 className="metric-label mb-1">Blockers</h4>
            <ul className="space-y-1">
              {state.blockers.map((blocker, index) => (
                <li key={index} className="text-rust-600 dark:text-rust-400">
                  {blocker.description}
                  {blocker.suggested_action !== undefined && (
                    <span className="text-ink-600 dark:text-parchment-300/80">
                      {' '}
                      — suggested: {blocker.suggested_action}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.in_progress.length > 0 && (
          <ListBlock title="In progress" items={state.in_progress} />
        )}
        {state.completed.length > 0 && <ListBlock title="Completed" items={state.completed} />}
      </div>
    </Panel>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4 className="metric-label mb-1">{title}</h4>
      <ul className="list-inside list-disc space-y-0.5 text-ink-700 dark:text-parchment-200">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function WorkStateSummary({ state }: { state: CheckpointDto['work_state'] }) {
  const parts: string[] = [];
  if (state.completed.length > 0) parts.push(`${state.completed.length} completed`);
  if (state.in_progress.length > 0) parts.push(`${state.in_progress.length} in progress`);
  if (state.next_steps.length > 0) parts.push(`${state.next_steps.length} next steps`);
  if (state.blockers.length > 0) parts.push(`${state.blockers.length} blockers`);
  if (state.changed_files.length > 0) parts.push(`${state.changed_files.length} changed files`);
  if (state.tests.length > 0) parts.push(`${state.tests.length} test results`);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/60">{parts.join(' · ')}</p>
  );
}
