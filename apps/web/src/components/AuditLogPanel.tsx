import { useAuditLog } from '../lib/queries.js';
import { EmptyState, ErrorState, LoadingState, Panel, RelativeTime, Table } from './primitives.jsx';

/**
 * The administrative audit trail, server-wide on the Dashboard and scoped to one project on its
 * Shrine.
 *
 * `GET /api/shrine/audit` requires `security:manage`, so both callers gate this panel on that
 * permission rather than rendering it and letting the request come back 403 — an absent panel
 * is the honest answer for a reader who may not see the trail at all.
 */
export function AuditLogPanel({ projectId }: { projectId?: string }) {
  const params =
    projectId === undefined ? '?limit=25' : `?limit=25&project_id=${encodeURIComponent(projectId)}`;
  const audit = useAuditLog(params);

  return (
    <Panel title="Audit log">
      {audit.isPending && <LoadingState />}
      {audit.isError && <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />}
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
      {audit.data?.items.length === 0 && (
        <EmptyState
          title="No administrative actions recorded"
          description={
            projectId === undefined
              ? 'Job interventions, device approvals and project lifecycle changes appear here with the reason given.'
              : 'Renames, archival and job interventions on this project appear here with the reason given.'
          }
        />
      )}
    </Panel>
  );
}
