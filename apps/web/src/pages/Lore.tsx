import type { LoreEntryDto, LoreSearchResponse, MemoryUpdateDto } from '@saga/contracts';
import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
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
import { useCan } from '../lib/permissions.jsx';
import {
  useContextSnapshot,
  useLoreEntries,
  useLoreLifecycle,
  useLoreSearch,
  useLoreUpdateAction,
  useLoreUpdates,
  useProposeLore,
} from '../lib/lore-queries.js';

const CATEGORIES = [
  'overview',
  'structure',
  'coding_style',
  'config',
  'running',
  'deploy',
  'debug',
  'logs',
  'testing',
  'server',
  'database',
  'api',
  'decision',
  'warning',
] as const;

const KINDS = ['fact', 'procedure', 'convention', 'map', 'entity', 'decision', 'warning'] as const;

const STATE_TONE: Record<string, BadgeTone> = {
  active: 'good',
  stale: 'warn',
  archived: 'neutral',
};

const UPDATE_TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  validating: 'info',
  ready: 'info',
  published: 'good',
  conflict: 'bad',
  failed: 'bad',
  cancelled: 'neutral',
};

export function LorePage() {
  const { projectRef = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const category = searchParams.get('category') ?? '';
  const kind = searchParams.get('kind') ?? '';
  const state = searchParams.get('state') ?? '';

  const query = new URLSearchParams();
  if (category.length > 0) query.set('category', category);
  if (kind.length > 0) query.set('kind', kind);
  if (state.length > 0) query.set('state', state);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  const entries = useLoreEntries(projectRef, suffix);
  const updates = useLoreUpdates(projectRef);
  const snapshot = useContextSnapshot(projectRef);

  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value.length === 0) next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  };

  const pending = (updates.data?.items ?? []).filter(
    (update) => update.state !== 'published' && update.state !== 'cancelled',
  );

  return (
    <div className="space-y-6">
      <SearchPanel projectRef={projectRef} />

      {pending.length > 0 && (
        <Panel title="Proposed changes">
          <ul className="divide-y divide-parchment-200/70 dark:divide-night-800/70">
            {pending.map((update) => (
              <UpdateRow key={update.id} update={update} />
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title="Lore entries"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {entries.data !== undefined && (
              <span className="text-xs text-ink-500 dark:text-parchment-300/70">
                revision {entries.data.memory_revision}
                {snapshot.data?.snapshot !== null && snapshot.data !== undefined && (
                  <> · snapshot {snapshot.data.snapshot.token_count} tokens</>
                )}
              </span>
            )}
            <FilterSelect
              label="Category"
              value={category}
              options={CATEGORIES}
              onChange={(value) => setFilter('category', value)}
            />
            <FilterSelect
              label="Kind"
              value={kind}
              options={KINDS}
              onChange={(value) => setFilter('kind', value)}
            />
            <FilterSelect
              label="State"
              value={state}
              options={['active', 'stale', 'archived']}
              onChange={(value) => setFilter('state', value)}
            />
          </div>
        }
      >
        {entries.isPending && <LoadingState />}
        {entries.isError && (
          <ErrorState error={entries.error} onRetry={() => void entries.refetch()} />
        )}
        {entries.data?.items.length === 0 && (
          <EmptyState
            title="No Lore recorded yet"
            description="Run `saga connect` in the project folder and let the agent propose initial Lore from local evidence, or add an entry below."
          />
        )}
        {entries.data !== undefined && entries.data.items.length > 0 && (
          <Table headers={['Entry', 'Category', 'Kind', 'State', 'Verification', 'Updated']}>
            {entries.data.items.map((entry) => (
              <EntryRow key={entry.id} projectRef={projectRef} entry={entry} />
            ))}
          </Table>
        )}
      </Panel>

      <ProposePanel projectRef={projectRef} />
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const id = `filter-${label.toLowerCase()}`;
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        Filter by {label.toLowerCase()}
      </label>
      <select
        id={id}
        className="field-input w-36 py-1 text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">All {label.toLowerCase()}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </>
  );
}

/** Copy for each lifecycle action, so the confirm row explains what it is about to do. */
const LIFECYCLE_COPY = {
  'mark-stale': {
    button: 'Mark stale',
    prompt: (key: string) => `Why is “${key}” no longer accurate?`,
    note: 'The entry is kept and stays searchable; it is excluded from core context and labelled wherever it appears.',
  },
  archive: {
    button: 'Archive',
    prompt: (key: string) => `Why is “${key}” no longer needed?`,
    note: 'The entry stops appearing in Lore, search and core context. Its version history is kept, and the audit log records this reason.',
  },
} as const;

type LifecycleAction = keyof typeof LIFECYCLE_COPY;

function EntryRow({ projectRef, entry }: { projectRef: string; entry: LoreEntryDto }) {
  const can = useCan();
  const markStale = useLoreLifecycle('mark-stale');
  const archive = useLoreLifecycle('archive');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState<LifecycleAction | null>(null);

  const mutation = confirming === 'archive' ? archive : markStale;
  const copy = confirming === null ? null : LIFECYCLE_COPY[confirming];

  const start = (action: LifecycleAction) => {
    setConfirming(action);
    setReason('');
  };

  return (
    <>
      <tr className="hover:bg-parchment-100/60 dark:hover:bg-night-800/40">
        <td className="table-cell">
          <Link
            className="link font-mono text-xs"
            to={`/projects/${encodeURIComponent(projectRef)}/lore/${encodeURIComponent(entry.memory_key)}`}
          >
            {entry.memory_key}
          </Link>
          {entry.stale_reason !== null && (
            <p className="mt-0.5 text-xs text-gold-600 dark:text-gold-400">{entry.stale_reason}</p>
          )}
        </td>
        <td className="table-cell text-xs">{entry.category}</td>
        <td className="table-cell text-xs">{entry.kind}</td>
        <td className="table-cell">
          <Badge tone={STATE_TONE[entry.state] ?? 'neutral'}>{entry.state}</Badge>
        </td>
        <td className="table-cell text-xs">
          {entry.current_version?.verification_state ?? '—'}
          {entry.current_version !== null && entry.current_version.embedding_state !== 'ready' && (
            <span className="ml-2">
              <Badge tone="warn">embedding {entry.current_version.embedding_state}</Badge>
            </span>
          )}
        </td>
        <td className="table-cell whitespace-nowrap text-xs text-ink-500 dark:text-parchment-300/70">
          <RelativeTime value={entry.updated_at} />
          {entry.state === 'active' && can('lore:propose') && (
            <button
              type="button"
              className="btn-secondary ml-2 py-0.5 text-xs"
              onClick={() => start('mark-stale')}
            >
              Mark stale
            </button>
          )}
          {entry.state !== 'archived' && can('lore:archive') && (
            <button
              type="button"
              className="btn-secondary ml-2 py-0.5 text-xs"
              onClick={() => start('archive')}
            >
              Archive
            </button>
          )}
        </td>
      </tr>
      {copy !== null && (
        <tr className="bg-parchment-100/70 dark:bg-night-850/70">
          <td colSpan={6} className="px-4 py-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1">
                <label className="field-label" htmlFor={`${confirming}-${entry.id}`}>
                  {copy.prompt(entry.memory_key)}
                </label>
                <input
                  id={`${confirming}-${entry.id}`}
                  className="field-input"
                  autoFocus
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">{copy.note}</p>
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={reason.trim().length === 0 || mutation.isPending}
                onClick={() =>
                  mutation.mutate(
                    { ref: projectRef, memoryKey: entry.memory_key, reason },
                    {
                      onSuccess: () => {
                        setConfirming(null);
                        setReason('');
                      },
                    },
                  )
                }
              >
                {copy.button}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
            {mutation.isError && <ErrorState error={mutation.error} />}
          </td>
        </tr>
      )}
    </>
  );
}

function UpdateRow({ update }: { update: MemoryUpdateDto }) {
  const can = useCan();
  const validate = useLoreUpdateAction('validate');
  const publish = useLoreUpdateAction('publish');
  const cancel = useLoreUpdateAction('cancel');
  const [error, setError] = useState<string | null>(null);

  const busy = validate.isPending || publish.isPending || cancel.isPending;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge tone={UPDATE_TONE[update.state] ?? 'neutral'}>{update.state}</Badge>
            <span className="text-sm font-medium">{update.summary}</span>
          </div>
          <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">
            {update.items.length} {update.items.length === 1 ? 'entry' : 'entries'}:{' '}
            {update.items.map((item) => item.memory_key).join(', ')}
          </p>
          {update.items.some((item) => item.conflicted) && (
            <p className="mt-1 text-xs font-medium text-rust-600 dark:text-rust-400">
              Some entries changed since this was proposed. Publishing will be refused; propose
              again from the current version.
            </p>
          )}
          {update.error !== null && (
            <p className="mt-1 text-xs text-rust-600 dark:text-rust-400">{update.error}</p>
          )}
        </div>

        <div className="flex gap-2">
          {can('lore:publish') && (update.state === 'draft' || update.state === 'validating') && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => validate.mutate({ updateId: update.id })}
            >
              Validate
            </button>
          )}
          {can('lore:publish') && update.state === 'ready' && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() =>
                publish.mutate(
                  { updateId: update.id },
                  { onError: (mutationError) => setError(mutationError.message) },
                )
              }
            >
              Approve and publish
            </button>
          )}
          {can('lore:propose') && update.state !== 'conflict' && update.state !== 'failed' && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                cancel.mutate({ updateId: update.id, reason: 'rejected in Guild Hall' })
              }
            >
              Reject
            </button>
          )}
        </div>
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-xs font-medium text-rust-600 dark:text-rust-400">
          {error}
        </p>
      )}
    </li>
  );
}

function SearchPanel({ projectRef }: { projectRef: string }) {
  const search = useLoreSearch();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<LoreSearchResponse | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (term.trim().length === 0) return;
    search.mutate({ ref: projectRef, query: term }, { onSuccess: setResults });
  };

  return (
    <Panel title="Search Lore">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 px-4 py-3">
        <div className="flex-1">
          <label className="field-label" htmlFor="lore-search">
            What do you need to know?
          </label>
          <input
            id="lore-search"
            className="field-input"
            placeholder="How do I debug refresh-token failures?"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={search.isPending}>
          {search.isPending ? 'Searching…' : 'Search'}
        </button>
      </form>

      {search.isError && <ErrorState error={search.error} />}

      {results !== null && (
        <div className="border-t border-parchment-200 px-4 py-3 dark:border-night-800">
          {results.mode === 'degraded' && (
            <p className="mb-2 rounded border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-xs text-gold-700 dark:text-gold-400">
              {results.warnings[0] ?? 'Search ran in degraded mode.'}
            </p>
          )}
          {results.hits.length === 0 ? (
            <p className="text-sm text-ink-500 dark:text-parchment-300/70">
              Nothing matched. Try different words, or record the knowledge below.
            </p>
          ) : (
            <ul className="space-y-3">
              {results.hits.map((hit) => (
                <li key={hit.memory_item_id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      className="link font-mono text-xs"
                      to={`/projects/${encodeURIComponent(projectRef)}/lore/${encodeURIComponent(hit.memory_key)}`}
                    >
                      {hit.memory_key}
                    </Link>
                    <Badge tone={STATE_TONE[hit.state] ?? 'neutral'}>{hit.state}</Badge>
                    <span className="text-xs text-ink-500 dark:text-parchment-300/60">
                      {hit.matched_by.join(' + ')} · {hit.score.toFixed(4)}
                    </span>
                    {hit.via_relation !== null && (
                      <span className="text-xs text-ink-500 dark:text-parchment-300/60">
                        via {hit.via_relation.relation} from {hit.via_relation.from_memory_key}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-ink-700 dark:text-parchment-200">{hit.body}</p>
                  {hit.stale_reason !== null && (
                    <p className="text-xs text-gold-600 dark:text-gold-400">
                      Stale: {hit.stale_reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

function ProposePanel({ projectRef }: { projectRef: string }) {
  const can = useCan();
  const propose = useProposeLore();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    memory_key: '',
    category: 'overview',
    kind: 'fact',
    body: '',
    verification_state: 'observed',
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    propose.mutate(
      {
        ref: projectRef,
        summary: `Record ${form.memory_key}`,
        entries: [
          {
            memory_key: form.memory_key,
            category: form.category,
            kind: form.kind,
            body: form.body,
            confidence: 0.9,
            verification_state: form.verification_state,
          },
        ],
      },
      {
        onSuccess: () => {
          setForm({ ...form, memory_key: '', body: '' });
          setOpen(false);
        },
      },
    );
  };

  // A viewer sees Lore but is offered no way to change it.
  if (!can('lore:propose')) return null;

  if (!open) {
    return (
      <div>
        <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
          Propose a Lore Entry
        </button>
      </div>
    );
  }

  return (
    <Panel title="Propose a Lore Entry">
      <form onSubmit={submit} className="space-y-3 px-4 py-3">
        <p className="text-xs text-ink-500 dark:text-parchment-300/70">
          Editing never changes the current version in place. This creates a candidate that goes
          through the same validation and publication pipeline as an agent proposal.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="field-label" htmlFor="propose-key">
              Memory key
            </label>
            <input
              id="propose-key"
              className="field-input font-mono text-xs"
              placeholder="run.api.local"
              required
              value={form.memory_key}
              onChange={(event) => setForm({ ...form, memory_key: event.target.value })}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="propose-category">
              Category
            </label>
            <select
              id="propose-category"
              className="field-input"
              value={form.category}
              onChange={(event) => setForm({ ...form, category: event.target.value })}
            >
              {CATEGORIES.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="propose-kind">
              Kind
            </label>
            <select
              id="propose-kind"
              className="field-input"
              value={form.kind}
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
            >
              {KINDS.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="field-label" htmlFor="propose-body">
            Body
          </label>
          <textarea
            id="propose-body"
            className="field-input min-h-24"
            required
            value={form.body}
            onChange={(event) => setForm({ ...form, body: event.target.value })}
          />
          <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/70">
            Never include credentials. Candidates containing secrets are rejected.
          </p>
        </div>

        {propose.isError && <ErrorState error={propose.error} />}

        <div className="flex gap-2">
          <button type="submit" className="btn-primary" disabled={propose.isPending}>
            {propose.isPending ? 'Proposing…' : 'Propose'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}
