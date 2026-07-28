import type { QuestDto, QuestStatus } from '@saga/contracts';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  RelativeTime,
  classNames,
  type BadgeTone,
} from '../components/primitives.jsx';
import { useCreateQuest, useQuests } from '../lib/quest-queries.js';
import { useCan } from '../lib/permissions.jsx';

/** Board columns, in the order the specification documents. */
const COLUMNS: { status: QuestStatus; title: string; tone: BadgeTone }[] = [
  { status: 'open', title: 'Open', tone: 'neutral' },
  { status: 'in_progress', title: 'In Progress', tone: 'info' },
  { status: 'waiting', title: 'Waiting', tone: 'warn' },
  { status: 'blocked', title: 'Blocked', tone: 'bad' },
  { status: 'completed', title: 'Completed', tone: 'good' },
];

const PRIORITY_TONE: Record<string, BadgeTone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warn',
  critical: 'bad',
};

export function QuestBoardPage() {
  const { projectRef = '' } = useParams();
  const can = useCan();
  const quests = useQuests(projectRef, '?limit=200');
  const create = useCreateQuest();
  const [title, setTitle] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim().length === 0) return;
    create.mutate({ ref: projectRef, title }, { onSuccess: () => setTitle('') });
  };

  const byStatus = new Map<QuestStatus, QuestDto[]>();
  for (const column of COLUMNS) byStatus.set(column.status, []);
  for (const quest of quests.data?.items ?? []) {
    byStatus.get(quest.status)?.push(quest);
  }
  // `cancelled` has no column of its own; it is shown alongside completed work.
  const cancelled = (quests.data?.items ?? []).filter((quest) => quest.status === 'cancelled');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-ink-800 dark:text-parchment-100">
            Quest Board
          </h2>
          <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
            Work that survives a session. A Quest keeps its checkpoints and handoffs however many
            agents touch it.
          </p>
        </div>

        {can('quest:write') && (
        <form onSubmit={submit} className="flex items-end gap-2">
          <div>
            <label className="field-label" htmlFor="new-quest">
              New Quest
            </label>
            <input
              id="new-quest"
              className="field-input w-72"
              placeholder="Add CSV report export"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </form>
        )}
      </div>

      {create.isError && <ErrorState error={create.error} />}
      {quests.isPending && <LoadingState label="Loading Quests…" />}
      {quests.isError && <ErrorState error={quests.error} onRetry={() => void quests.refetch()} />}

      {quests.data?.items.length === 0 && (
        <Panel>
          <EmptyState
            title="No Quests yet"
            description="A Quest is created automatically when an agent session receives its first task, or you can add one above."
          />
        </Panel>
      )}

      {quests.data !== undefined && quests.data.items.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {COLUMNS.map((column) => {
            const items = byStatus.get(column.status) ?? [];
            const extra = column.status === 'completed' ? cancelled : [];
            return (
              <section
                key={column.status}
                className="panel flex flex-col"
                aria-label={`${column.title} Quests`}
              >
                <header className="panel-header">
                  <h3 className="panel-title">{column.title}</h3>
                  <span className="text-xs tabular-nums text-ink-500 dark:text-parchment-300/70">
                    {items.length + extra.length}
                  </span>
                </header>
                <ul className="flex-1 space-y-2 p-2">
                  {[...items, ...extra].map((quest) => (
                    <QuestCard key={quest.id} projectRef={projectRef} quest={quest} />
                  ))}
                  {items.length + extra.length === 0 && (
                    <li className="px-2 py-4 text-center text-xs text-ink-500 dark:text-parchment-300/60">
                      Nothing here
                    </li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QuestCard({ projectRef, quest }: { projectRef: string; quest: QuestDto }) {
  const scopeCount =
    (quest.scope.modules?.length ?? 0) +
    (quest.scope.files?.length ?? 0) +
    (quest.scope.components?.length ?? 0);

  return (
    <li>
      <Link
        to={`/projects/${encodeURIComponent(projectRef)}/quests/${quest.id}`}
        className={classNames(
          'block rounded border border-parchment-200 bg-white/80 p-2 transition-colors',
          'hover:border-sigil-400 dark:border-night-800 dark:bg-night-850/80 dark:hover:border-sigil-400',
        )}
      >
        <p className="text-sm font-medium text-ink-800 dark:text-parchment-100">{quest.title}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {quest.priority !== 'normal' && (
            <Badge tone={PRIORITY_TONE[quest.priority] ?? 'neutral'}>{quest.priority}</Badge>
          )}
          {quest.status === 'cancelled' && <Badge tone="neutral">cancelled</Badge>}
          <span className="text-xs text-ink-500 dark:text-parchment-300/60">rev {quest.revision}</span>
          {scopeCount > 0 && (
            <span className="text-xs text-ink-500 dark:text-parchment-300/60">
              · {scopeCount} scope item{scopeCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/60">
          <RelativeTime value={quest.last_activity_at} />
        </p>
      </Link>
    </li>
  );
}
