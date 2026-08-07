import type { MemoryLinkDto, MemoryRelation } from '@saga/contracts';
// Subpath, not the barrel: the barrel drags Zod and every server-side schema into the bundle.
import { MEMORY_RELATIONS } from '@saga/contracts/constants';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  Table,
} from '../components/primitives.jsx';
import {
  useConfirmLoreLink,
  useCreateLoreLink,
  useDeleteLoreLink,
  useLoreEntries,
  useLoreLinks,
} from '../lib/lore-queries.js';
import { useCan } from '../lib/permissions.jsx';

/** How a relation got here. `model` in this table means a proposal somebody confirmed. */
const SOURCE_LABEL: Record<MemoryLinkDto['source'], string> = {
  human: 'Added by hand',
  deterministic: 'Found in the text',
  model: 'Confirmed proposal',
};

/**
 * The Relations tab: the knowledge graph between Lore Entries.
 *
 * Relations are identity-level metadata rather than versioned content, so they are edited in
 * place here instead of going through the candidate/publish pipeline that Lore bodies use.
 * Relations the server inferred are reviewed here too, above the graph they are not yet part of.
 */
export function ProjectRelations() {
  const { projectRef = '' } = useParams();
  const can = useCan();
  const links = useLoreLinks(projectRef);
  const proposals = useLoreLinks(projectRef, 'proposed');
  const entries = useLoreEntries(projectRef, '?limit=200');

  if (links.isPending) return <LoadingState label="Loading relations…" />;
  if (links.isError) return <ErrorState error={links.error} onRetry={() => void links.refetch()} />;

  const items = links.data.items;
  const pending = proposals.data?.items ?? [];
  const keys = (entries.data?.items ?? []).map((entry) => entry.memory_key).sort();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-ink-800 dark:text-parchment-100">
          Relations
        </h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
          How this project&rsquo;s knowledge fits together. Search expands one hop along these
          edges, so a relation makes related Lore reachable from a single query.
        </p>
      </div>

      {can('lore:propose') && pending.length > 0 && (
        <ProposedRelations projectRef={projectRef} items={pending} />
      )}

      {can('lore:propose') && <CreateRelation projectRef={projectRef} memoryKeys={keys} />}

      <Panel title={`Relations (${String(items.length)})`}>
        {items.length === 0 ? (
          <EmptyState
            title="No relations recorded"
            description="Link an entry to the server it runs on, the database it uses or the tests that cover it."
          />
        ) : (
          <Table
            headers={['From', 'Relation', 'To', 'Source', can('lore:propose') ? 'Actions' : '']}
          >
            {items.map((link) => (
              <RelationRow
                key={link.id}
                link={link}
                projectRef={projectRef}
                editable={can('lore:propose')}
              />
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

/**
 * The review queue for relations the model inferred.
 *
 * Kept above the graph rather than mixed into it: a proposal is not part of the project's
 * knowledge yet, and search does not traverse one. Confirming promotes it; removing it is the
 * rejection, because a proposal nobody wants is simply not kept.
 */
function ProposedRelations({ projectRef, items }: { projectRef: string; items: MemoryLinkDto[] }) {
  return (
    <Panel title={`Proposed by inference (${String(items.length)})`}>
      <p className="px-4 pt-3 text-sm text-ink-500 dark:text-parchment-300/70">
        A model read these entries and suggested how they relate. Nothing here is part of the graph
        or reachable from search until you confirm it.
      </p>
      <Table headers={['From', 'Relation', 'To', 'Why', 'Actions']}>
        {items.map((link) => (
          <ProposalRow key={link.id} link={link} projectRef={projectRef} />
        ))}
      </Table>
    </Panel>
  );
}

function ProposalRow({ link, projectRef }: { link: MemoryLinkDto; projectRef: string }) {
  const confirm = useConfirmLoreLink();
  const reject = useDeleteLoreLink();
  const busy = confirm.isPending || reject.isPending;
  const entryPath = (key: string) =>
    `/projects/${encodeURIComponent(projectRef)}/lore/${encodeURIComponent(key)}`;

  return (
    <tr>
      <td className="table-cell font-mono text-xs">
        <Link className="link" to={entryPath(link.from_memory_key)}>
          {link.from_memory_key}
        </Link>
      </td>
      <td className="table-cell">
        <Badge tone="neutral">{link.relation}</Badge>
      </td>
      <td className="table-cell font-mono text-xs">
        <Link className="link" to={entryPath(link.to_memory_key)}>
          {link.to_memory_key}
        </Link>
      </td>
      <td className="table-cell text-xs text-ink-500 dark:text-parchment-300/70">
        {link.rationale === null || link.rationale === '' ? '—' : link.rationale}
        {link.confidence !== null && (
          <span className="ml-2 font-mono text-ink-400 dark:text-parchment-300/50">
            {link.confidence.toFixed(2)}
          </span>
        )}
      </td>
      <td className="table-cell">
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary py-1 text-xs"
            disabled={busy}
            onClick={() => confirm.mutate({ linkId: link.id })}
          >
            Confirm
          </button>
          <button
            type="button"
            className="btn-secondary py-1 text-xs"
            disabled={busy}
            onClick={() => reject.mutate({ linkId: link.id })}
          >
            Reject
          </button>
        </div>
      </td>
    </tr>
  );
}

function RelationRow({
  link,
  projectRef,
  editable,
}: {
  link: MemoryLinkDto;
  projectRef: string;
  editable: boolean;
}) {
  const remove = useDeleteLoreLink();
  const entryPath = (key: string) =>
    `/projects/${encodeURIComponent(projectRef)}/lore/${encodeURIComponent(key)}`;

  return (
    <tr>
      <td className="table-cell font-mono text-xs">
        <Link className="link" to={entryPath(link.from_memory_key)}>
          {link.from_memory_key}
        </Link>
      </td>
      <td className="table-cell">
        <Badge tone="neutral">{link.relation}</Badge>
      </td>
      <td className="table-cell font-mono text-xs">
        <Link className="link" to={entryPath(link.to_memory_key)}>
          {link.to_memory_key}
        </Link>
      </td>
      <td className="table-cell text-xs text-ink-500 dark:text-parchment-300/70">
        {SOURCE_LABEL[link.source]}
      </td>
      <td className="table-cell">
        {editable ? (
          <button
            type="button"
            className="btn-secondary py-1 text-xs"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ linkId: link.id })}
          >
            Remove
          </button>
        ) : (
          <span className="text-xs text-ink-500 dark:text-parchment-300/60">—</span>
        )}
      </td>
    </tr>
  );
}

function CreateRelation({ projectRef, memoryKeys }: { projectRef: string; memoryKeys: string[] }) {
  const create = useCreateLoreLink();
  const [from, setFrom] = useState('');
  const [relation, setRelation] = useState<MemoryRelation>('relates_to');
  const [to, setTo] = useState('');

  const ready = from.length > 0 && to.length > 0 && from !== to;

  return (
    <Panel title="Add a relation">
      <form
        className="flex flex-wrap items-end gap-3 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          create.mutate(
            { ref: projectRef, from_memory_key: from, relation, to_memory_key: to },
            {
              onSuccess: () => {
                setFrom('');
                setTo('');
              },
            },
          );
        }}
      >
        <div>
          <label className="field-label" htmlFor="relation-from">
            From
          </label>
          <select
            id="relation-from"
            className="field-input"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          >
            <option value="">Select an entry…</option>
            {memoryKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="relation-kind">
            Relation
          </label>
          <select
            id="relation-kind"
            className="field-input"
            value={relation}
            onChange={(event) => setRelation(event.target.value as MemoryRelation)}
          >
            {MEMORY_RELATIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="relation-to">
            To
          </label>
          <select
            id="relation-to"
            className="field-input"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          >
            <option value="">Select an entry…</option>
            {memoryKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className="btn-primary" disabled={!ready || create.isPending}>
          Add relation
        </button>
      </form>

      {from !== '' && from === to && (
        <p className="px-4 pb-3 text-xs text-rust-700 dark:text-rust-400">
          An entry cannot relate to itself.
        </p>
      )}
      {create.isError && (
        <div className="px-4 pb-3">
          <ErrorState error={create.error} />
        </div>
      )}
    </Panel>
  );
}
