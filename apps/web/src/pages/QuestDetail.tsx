import type {
  CheckpointDto,
  ClaimDto,
  DependencyType,
  QuestDependencyDto,
  QuestDto,
  QuestScope,
  QuestStatus,
  WorkState,
} from '@saga/contracts';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClaimsTable } from '../components/ClaimsTable.jsx';
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
import { usePartyClaims, usePartyStatus } from '../lib/party-queries.js';
import {
  useAddDependency,
  useQuestDetail,
  useQuestLifecycle,
  useQuests,
  useRemoveDependency,
  useUpdateQuest,
} from '../lib/quest-queries.js';
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

const DEPENDENCY_TYPES: DependencyType[] = ['blocks', 'requires_output', 'must_complete_before'];

/** Every scope field is a list of free-form strings; the form edits them as one line each. */
const SCOPE_FIELDS = [
  ['modules', 'Modules'],
  ['components', 'Components'],
  ['apis', 'APIs'],
  ['databases', 'Databases'],
  ['files', 'Files'],
  ['issue_keys', 'Issue keys'],
] as const;

type ScopeField = (typeof SCOPE_FIELDS)[number][0];

export function QuestDetailPage() {
  const can = useCan();
  const { projectRef = '', questId = '' } = useParams();
  const detail = useQuestDetail(questId);
  const update = useUpdateQuest();
  const reopen = useQuestLifecycle('reopen');
  const archive = useQuestLifecycle('archive');
  const [reopenReason, setReopenReason] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [editing, setEditing] = useState(false);

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
          {quest.archived_at !== null && <Badge tone="neutral">archived</Badge>}
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
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setEditing((open) => !open)}
              >
                {editing ? 'Close editor' : 'Edit objective and scope'}
              </button>
              {closed && (
                <button type="button" className="btn-secondary" onClick={() => setReopenReason('')}>
                  Reopen
                </button>
              )}
              {closed && quest.archived_at === null && (
                <button type="button" className="btn-secondary" onClick={() => setArchiving(true)}>
                  Archive
                </button>
              )}
            </>
          )}
        </div>
        {update.isError && <ErrorState error={update.error} />}
      </div>

      {editing && <EditQuestPanel quest={quest} onDone={() => setEditing(false)} />}

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

      {archiving && (
        <Panel title="Archive this Quest">
          <div className="space-y-3 px-4 py-3">
            <p className="text-sm text-ink-600 dark:text-parchment-300/80">
              Archiving removes “{quest.title}” from the Quest Board. Its checkpoints, handoffs and
              claims history are kept, and reopening it brings it back.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={archive.isPending}
                onClick={() =>
                  archive.mutate({ questId }, { onSuccess: () => setArchiving(false) })
                }
              >
                Confirm archive
              </button>
              <button type="button" className="btn-secondary" onClick={() => setArchiving(false)}>
                Cancel
              </button>
            </div>
            {archive.isError && <ErrorState error={archive.error} />}
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

          <PartyPanel projectRef={projectRef} questId={questId} />
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

          <DependenciesPanel
            projectRef={projectRef}
            questId={questId}
            dependencies={dependencies}
          />

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

function scopeToForm(scope: QuestScope): Record<ScopeField, string> {
  const form = {} as Record<ScopeField, string>;
  for (const [field] of SCOPE_FIELDS) form[field] = (scope[field] ?? []).join(', ');
  return form;
}

function formToScope(form: Record<ScopeField, string>): QuestScope {
  const scope: QuestScope = {};
  for (const [field] of SCOPE_FIELDS) {
    const values = form[field]
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    // An empty field means "no declaration", not an empty list, so the key is left out.
    if (values.length > 0) scope[field] = values;
  }
  return scope;
}

function EditQuestPanel({ quest, onDone }: { quest: QuestDto; onDone: () => void }) {
  const update = useUpdateQuest();
  const [objective, setObjective] = useState(quest.objective ?? '');
  const [scope, setScope] = useState(() => scopeToForm(quest.scope));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        questId: quest.id,
        // Clearing the field removes the objective rather than storing an empty string.
        objective: objective.trim().length === 0 ? null : objective.trim(),
        scope: formToScope(scope),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <Panel title="Edit objective and scope">
      <form onSubmit={submit} className="space-y-3 px-4 py-3">
        <div>
          <label className="field-label" htmlFor="quest-objective">
            Objective
          </label>
          <textarea
            id="quest-objective"
            className="field-input min-h-24"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {SCOPE_FIELDS.map(([field, label]) => (
            <div key={field}>
              <label className="field-label" htmlFor={`scope-${field}`}>
                {label}
              </label>
              <input
                id={`scope-${field}`}
                className="field-input font-mono text-xs"
                placeholder="comma separated"
                value={scope[field]}
                onChange={(event) => setScope({ ...scope, [field]: event.target.value })}
              />
            </div>
          ))}
        </div>

        <p className="text-xs text-ink-500 dark:text-parchment-300/70">
          Scope is what Party compares to warn about overlapping work. None of it is a
          version-control coordinate.
        </p>

        {update.isError && <ErrorState error={update.error} />}

        <div className="flex gap-2">
          <button type="submit" className="btn-primary" disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="btn-secondary" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}

function DependenciesPanel({
  projectRef,
  questId,
  dependencies,
}: {
  projectRef: string;
  questId: string;
  dependencies: QuestDependencyDto[];
}) {
  const can = useCan();
  const writable = can('quest:write');
  const add = useAddDependency();
  const remove = useRemoveDependency();
  const [adding, setAdding] = useState(false);
  const [dependsOn, setDependsOn] = useState('');
  const [type, setType] = useState<DependencyType>('blocks');

  // Only fetched while the picker is open: the Quest list is not needed to read dependencies.
  const candidates = useQuests(adding ? projectRef : '', '?limit=200');
  const taken = new Set(dependencies.map((dependency) => dependency.depends_on_work_item_id));
  const options = (candidates.data?.items ?? []).filter(
    (quest) => quest.id !== questId && !taken.has(quest.id),
  );

  if (!writable && dependencies.length === 0) return null;

  return (
    <Panel
      title="Dependencies"
      actions={
        writable && !adding ? (
          <button
            type="button"
            className="btn-secondary py-0.5 text-xs"
            onClick={() => setAdding(true)}
          >
            Add
          </button>
        ) : undefined
      }
    >
      {dependencies.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-500 dark:text-parchment-300/70">
          This Quest depends on nothing else.
        </p>
      ) : (
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
              {writable && (
                <button
                  type="button"
                  className="btn-secondary ml-2 py-0.5 text-xs"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate({
                      questId,
                      dependsOnWorkItemId: dependency.depends_on_work_item_id,
                    })
                  }
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="space-y-2 border-t border-parchment-200 px-4 py-3 dark:border-night-800">
          <div>
            <label className="field-label" htmlFor="dependency-type">
              This Quest
            </label>
            <select
              id="dependency-type"
              className="field-input py-1 text-xs"
              value={type}
              onChange={(event) => setType(event.target.value as DependencyType)}
            >
              {DEPENDENCY_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="dependency-target">
              Depends on
            </label>
            <select
              id="dependency-target"
              className="field-input py-1 text-xs"
              value={dependsOn}
              onChange={(event) => setDependsOn(event.target.value)}
            >
              <option value="">Choose a Quest…</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
          </div>
          {candidates.isError && <ErrorState error={candidates.error} />}
          {add.isError && <ErrorState error={add.error} />}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary py-1 text-xs"
              disabled={dependsOn.length === 0 || add.isPending}
              onClick={() =>
                add.mutate(
                  { questId, dependsOnWorkItemId: dependsOn, dependencyType: type },
                  {
                    onSuccess: () => {
                      setAdding(false);
                      setDependsOn('');
                    },
                  },
                )
              }
            >
              Add dependency
            </button>
            <button
              type="button"
              className="btn-secondary py-1 text-xs"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {remove.isError && <ErrorState error={remove.error} />}
    </Panel>
  );
}

/**
 * Party members working this Quest and every claim it has held. Both are project-scoped feeds
 * filtered to this Quest, so no extra endpoint is needed.
 */
function PartyPanel({ projectRef, questId }: { projectRef: string; questId: string }) {
  const can = useCan();
  const enabled = can('party:read') ? projectRef : '';
  const status = usePartyStatus(enabled);
  const claims = usePartyClaims(enabled);

  if (!can('party:read')) return null;

  const members = (status.data?.active_agents ?? []).filter(
    (agent) => agent.work_item_id === questId,
  );
  const questClaims: ClaimDto[] = (claims.data?.items ?? []).filter(
    (claim) => claim.work_item_id === questId,
  );

  return (
    <Panel title="Party">
      {status.data?.mode === 'off' ? (
        <p className="px-4 py-3 text-sm text-ink-600 dark:text-parchment-300/80">
          Live coordination is disabled on this server (
          <code className="font-mono text-xs">PARTY_MODE=off</code>), so this Quest has no members
          or claims to show.
        </p>
      ) : (
        <>
          {status.isPending && <LoadingState />}
          {/* A failed fetch must not read as "nobody is working on this Quest". */}
          {status.isError && (
            <ErrorState error={status.error} onRetry={() => void status.refetch()} />
          )}
          {status.data !== undefined && members.length === 0 && (
            <p className="px-4 py-3 text-sm text-ink-500 dark:text-parchment-300/70">
              No agent is working on this Quest right now.
            </p>
          )}
          {members.length > 0 && (
            <ul className="divide-y divide-parchment-200/70 dark:divide-night-800/70">
              {members.map((member) => (
                <li key={member.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{member.agent_instance_id}</span>
                    <Badge tone={member.live ? 'good' : 'warn'}>
                      {member.live ? 'live' : 'lease expired'}
                    </Badge>
                    <Badge tone="neutral">{member.state}</Badge>
                    {member.workspace_label !== null && (
                      <span className="font-mono text-xs text-ink-500 dark:text-parchment-300/60">
                        {member.workspace_label}
                      </span>
                    )}
                    <span className="text-xs text-ink-500 dark:text-parchment-300/60">
                      heartbeat <RelativeTime value={member.heartbeat_at} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-parchment-200 dark:border-night-800">
            {claims.isPending && <LoadingState />}
            {claims.isError && (
              <ErrorState error={claims.error} onRetry={() => void claims.refetch()} />
            )}
            {claims.data !== undefined && questClaims.length === 0 && (
              <p className="px-4 py-3 text-sm text-ink-500 dark:text-parchment-300/70">
                No resource has been claimed for this Quest.
              </p>
            )}
            {questClaims.length > 0 && <ClaimsTable claims={questClaims} />}
          </div>
        </>
      )}
    </Panel>
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

        {/* Without version control these three are how the next agent picks the work up: what
            was touched, what was run, and what the tests said. */}
        {state.changed_files.length > 0 && <ChangedFiles files={state.changed_files} />}
        {state.commands.length > 0 && <Commands commands={state.commands} />}
        {state.tests.length > 0 && <Tests tests={state.tests} />}
      </div>
    </Panel>
  );
}

function ChangedFiles({ files }: { files: WorkState['changed_files'] }) {
  return (
    <div>
      <h4 className="metric-label mb-1">Changed files</h4>
      <ul className="space-y-0.5 font-mono text-xs text-ink-700 dark:text-parchment-200">
        {files.map((file, index) => (
          <li key={index}>
            {file.path}
            {file.base_hash !== undefined && file.current_hash !== undefined && (
              <span className="ml-2 text-ink-500 dark:text-parchment-300/60">
                {file.base_hash === file.current_hash ? 'unchanged' : 'modified'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const COMMAND_TONE: Record<string, BadgeTone> = {
  succeeded: 'good',
  failed: 'bad',
  skipped: 'neutral',
  running: 'info',
};

function Commands({ commands }: { commands: WorkState['commands'] }) {
  return (
    <div>
      <h4 className="metric-label mb-1">Commands</h4>
      <ul className="space-y-1">
        {commands.map((command, index) => (
          <li key={index} className="flex flex-wrap items-baseline gap-2">
            <code className="font-mono text-xs text-ink-700 dark:text-parchment-200">
              {command.command}
            </code>
            {command.status !== undefined && (
              <Badge tone={COMMAND_TONE[command.status] ?? 'neutral'}>{command.status}</Badge>
            )}
            {command.summary !== undefined && (
              <span className="text-xs text-ink-500 dark:text-parchment-300/70">
                {command.summary}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const TEST_TONE: Record<string, BadgeTone> = {
  passed: 'good',
  failed: 'bad',
  blocked: 'bad',
  skipped: 'neutral',
  running: 'info',
};

function Tests({ tests }: { tests: WorkState['tests'] }) {
  return (
    <div>
      <h4 className="metric-label mb-1">Test results</h4>
      <ul className="space-y-1">
        {tests.map((test, index) => (
          <li key={index} className="flex flex-wrap items-baseline gap-2">
            <span className="text-ink-700 dark:text-parchment-200">{test.name}</span>
            <Badge tone={TEST_TONE[test.status] ?? 'neutral'}>{test.status}</Badge>
            {test.summary !== undefined && (
              <span className="text-xs text-ink-500 dark:text-parchment-300/70">
                {test.summary}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
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
  if (state.commands.length > 0) parts.push(`${state.commands.length} commands`);
  if (state.tests.length > 0) parts.push(`${state.tests.length} test results`);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/60">{parts.join(' · ')}</p>
  );
}
