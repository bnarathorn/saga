import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  ErrorState,
  LoadingState,
  Panel,
  RelativeTime,
  Table,
} from '../components/primitives.jsx';
import { useLoreEntry, useLoreVersions } from '../lib/lore-queries.js';

export function LoreEntryPage() {
  const { projectRef = '', memoryKey = '' } = useParams();
  const entry = useLoreEntry(projectRef, memoryKey);
  const versions = useLoreVersions(projectRef, memoryKey);

  if (entry.isPending) return <LoadingState label="Loading Lore entry…" />;
  if (entry.isError) return <ErrorState error={entry.error} onRetry={() => void entry.refetch()} />;

  const { entry: item, links } = entry.data;
  const current = item.current_version;

  return (
    <div className="space-y-6">
      <div>
        <Link className="link text-sm" to={`/projects/${encodeURIComponent(projectRef)}/lore`}>
          ← All Lore
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="font-display font-mono text-xl text-ink-800 dark:text-parchment-100">
            {item.memory_key}
          </h2>
          <Badge
            tone={item.state === 'active' ? 'good' : item.state === 'stale' ? 'warn' : 'neutral'}
          >
            {item.state}
          </Badge>
          <Badge tone="neutral">{item.category}</Badge>
          <Badge tone="neutral">{item.kind}</Badge>
          <Badge tone="info">importance {item.importance}</Badge>
        </div>
        {item.stale_reason !== null && (
          <p className="mt-2 rounded border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-sm text-gold-700 dark:text-gold-400">
            Marked stale: {item.stale_reason}
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Current version" className="lg:col-span-2">
          {current === null ? (
            <p className="px-4 py-6 text-sm text-ink-500 dark:text-parchment-300/70">
              This entry has an identity but no published version yet — its candidate is still in
              the proposal pipeline.
            </p>
          ) : (
            <div className="space-y-4 px-4 py-3">
              <p className="whitespace-pre-wrap text-sm text-ink-800 dark:text-parchment-100">
                {current.body}
              </p>

              {Object.keys(current.data).length > 0 && (
                <div>
                  <h3 className="metric-label mb-1">Structured data</h3>
                  <pre className="overflow-x-auto rounded bg-parchment-100 p-3 text-xs dark:bg-night-850">
                    {JSON.stringify(current.data, null, 2)}
                  </pre>
                </div>
              )}

              {current.evidence.length > 0 && (
                <div>
                  <h3 className="metric-label mb-1">Evidence</h3>
                  <ul className="space-y-0.5 font-mono text-xs text-ink-600 dark:text-parchment-300/80">
                    {current.evidence.map((item, index) => (
                      <li key={index}>
                        {String(item.path)}
                        {item.content_hash !== undefined && (
                          <span className="ml-2 text-ink-500 dark:text-parchment-300/60">
                            {String(item.content_hash).slice(0, 20)}…
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel title="Metadata">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-4 py-3 text-sm">
            <dt className="text-ink-500 dark:text-parchment-300/70">Volatility</dt>
            <dd>{item.volatility}</dd>
            <dt className="text-ink-500 dark:text-parchment-300/70">Verification</dt>
            <dd>{current?.verification_state ?? '—'}</dd>
            <dt className="text-ink-500 dark:text-parchment-300/70">Confidence</dt>
            <dd>{current === null ? '—' : current.confidence.toFixed(2)}</dd>
            <dt className="text-ink-500 dark:text-parchment-300/70">Embedding</dt>
            <dd>
              <Badge tone={current?.embedding_state === 'ready' ? 'good' : 'warn'}>
                {current?.embedding_state ?? 'none'}
              </Badge>
            </dd>
            <dt className="text-ink-500 dark:text-parchment-300/70">Last verified</dt>
            <dd>
              <RelativeTime value={item.last_verified_at} />
            </dd>
            <dt className="text-ink-500 dark:text-parchment-300/70">Created</dt>
            <dd>
              <RelativeTime value={item.created_at} />
            </dd>
          </dl>
        </Panel>
      </div>

      {links.length > 0 && (
        <Panel title="Relations">
          <ul className="divide-y divide-parchment-200/70 px-4 dark:divide-night-800/70">
            {links.map((link) => (
              <li key={link.id} className="py-2 font-mono text-xs">
                <Link
                  className="link"
                  to={`/projects/${encodeURIComponent(projectRef)}/lore/${encodeURIComponent(link.from_memory_key)}`}
                >
                  {link.from_memory_key}
                </Link>
                <span className="mx-2 text-ink-500 dark:text-parchment-300/60">
                  {link.relation}
                </span>
                <Link
                  className="link"
                  to={`/projects/${encodeURIComponent(projectRef)}/lore/${encodeURIComponent(link.to_memory_key)}`}
                >
                  {link.to_memory_key}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Version history">
        {versions.isPending && <LoadingState />}
        {versions.data !== undefined && (
          <Table headers={['Version', 'Verification', 'Confidence', 'Embedding', 'Created']}>
            {versions.data.items.map((version) => (
              <tr key={version.id}>
                <td className="table-cell font-mono text-xs">
                  {version.id.slice(0, 8)}
                  {version.id === versions.data.current_version_id && (
                    <span className="ml-2">
                      <Badge tone="good">current</Badge>
                    </span>
                  )}
                </td>
                <td className="table-cell text-xs">{version.verification_state}</td>
                <td className="table-cell text-xs tabular-nums">{version.confidence.toFixed(2)}</td>
                <td className="table-cell text-xs">{version.embedding_state}</td>
                <td className="table-cell whitespace-nowrap text-xs text-ink-500 dark:text-parchment-300/70">
                  <RelativeTime value={version.created_at} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
