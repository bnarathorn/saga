import type { ClaimDto, OverlapDto, PartyStatusDto } from '@saga/contracts';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
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
import { api } from '../lib/api.js';
import { useCan } from '../lib/permissions.jsx';
import { POLL } from '../lib/queries.js';

const SEVERITY_TONE: Record<string, BadgeTone> = {
  critical: 'bad',
  warning: 'warn',
  info: 'neutral',
};

const CLAIM_TONE: Record<string, BadgeTone> = {
  active: 'good',
  released: 'neutral',
  expired: 'warn',
  revoked: 'bad',
};

export function PartyPage() {
  const can = useCan();
  const { projectRef = '' } = useParams();
  const client = useQueryClient();

  const status = useQuery({
    queryKey: ['party', 'status', projectRef],
    queryFn: ({ signal }) =>
      api.get<PartyStatusDto>(`/api/projects/${encodeURIComponent(projectRef)}/party/status`, signal),
    // Party is live state, so it refreshes faster than durable views.
    refetchInterval: POLL.fast,
    enabled: projectRef.length > 0,
  });

  const history = useQuery({
    queryKey: ['party', 'claims', projectRef],
    queryFn: ({ signal }) =>
      api.get<{ items: ClaimDto[] }>(
        `/api/projects/${encodeURIComponent(projectRef)}/party/claims?include_finished=true`,
        signal,
      ),
    refetchInterval: POLL.normal,
    enabled: projectRef.length > 0,
  });

  const revoke = useMutation({
    mutationFn: ({ claimId, reason }: { claimId: string; reason: string }) =>
      api.post(`/api/party/claims/${claimId}/revoke`, { reason, confirm: true }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['party'] });
    },
  });

  const [revoking, setRevoking] = useState<{ id: string; label: string } | null>(null);
  const [reason, setReason] = useState('');

  if (status.isPending) return <LoadingState label="Loading Party…" />;
  if (status.isError) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;

  const data = status.data;

  if (data.mode === 'off') {
    return (
      <Panel title="Party">
        <div className="px-4 py-6 text-sm text-ink-600 dark:text-parchment-300/80">
          <p className="font-medium">Live coordination is disabled on this server.</p>
          <p className="mt-1">
            <code className="font-mono text-xs">PARTY_MODE=off</code>. Lore and Quest are
            unaffected: agents can still record knowledge, checkpoints and handoffs.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-ink-800 dark:text-parchment-100">
            Party
          </h2>
          <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
            Live agents, their declared scope and the resources they hold. Saga warns and
            coordinates; it never merges files.
          </p>
        </div>
        <Badge tone={data.mode === 'strict' ? 'good' : 'warn'}>PARTY_MODE={data.mode}</Badge>
      </div>

      {data.overlaps.length > 0 && (
        <Panel title="Overlap warnings">
          <ul className="divide-y divide-parchment-200/70 dark:divide-night-800/70">
            {data.overlaps.map((overlap, index) => (
              <OverlapRow key={index} overlap={overlap} />
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Active agents">
        {data.active_agents.length === 0 ? (
          <EmptyState
            title="No agents are working right now"
            description="An agent run appears here as soon as a session starts and holds a live lease."
          />
        ) : (
          <ul className="divide-y divide-parchment-200/70 dark:divide-night-800/70">
            {data.active_agents.map((agent) => (
              <li key={agent.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{agent.client}</span>
                  <Badge tone={agent.live ? 'good' : 'warn'}>
                    {agent.live ? 'live' : 'lease expired'}
                  </Badge>
                  <Badge tone="neutral">{agent.state}</Badge>
                  {agent.workspace_label !== null && (
                    <span className="font-mono text-xs text-ink-500 dark:text-parchment-300/60">
                      {agent.workspace_label}
                    </span>
                  )}
                  <span className="text-xs text-ink-500 dark:text-parchment-300/60">
                    heartbeat <RelativeTime value={agent.heartbeat_at} />
                    {agent.lease_expires_at !== null && (
                      <> · lease expires <RelativeTime value={agent.lease_expires_at} /></>
                    )}
                  </span>
                </div>

                <p className="mt-1 text-sm text-ink-600 dark:text-parchment-300/80">
                  {agent.quest_title ?? 'No Quest attached yet'}
                </p>

                {Object.keys(agent.scope).length > 0 && (
                  <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/60">
                    Scope:{' '}
                    {Object.entries(agent.scope)
                      .map(([field, values]) => `${field} ${(values as string[]).slice(0, 3).join(', ')}`)
                      .join(' · ')}
                  </p>
                )}

                {agent.claims.length > 0 && (
                  <p className="mt-1 text-xs text-ink-500 dark:text-parchment-300/60">
                    Claims:{' '}
                    {agent.claims
                      .map((claim) => `${claim.resource_type}:${claim.resource_key}`)
                      .join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Claims">
        {history.data === undefined || history.data.items.length === 0 ? (
          <EmptyState title="No claims recorded" />
        ) : (
          <Table
            headers={['Resource', 'Policy', 'Mode', 'Owner', 'State', 'Lease', 'Actions']}
          >
            {history.data.items.map((claim) => (
              <tr key={claim.id}>
                <td className="table-cell font-mono text-xs">
                  {claim.resource_type}:{claim.resource_key}
                </td>
                <td className="table-cell text-xs">{claim.resource_policy}</td>
                <td className="table-cell text-xs">{claim.mode}</td>
                <td className="table-cell text-xs">
                  {claim.work_item_title}
                  <span className="ml-1 text-ink-500 dark:text-parchment-300/60">
                    ({claim.client})
                  </span>
                </td>
                <td className="table-cell">
                  <Badge tone={CLAIM_TONE[claim.state] ?? 'neutral'}>{claim.state}</Badge>
                </td>
                <td className="table-cell whitespace-nowrap text-xs text-ink-500 dark:text-parchment-300/70">
                  <RelativeTime value={claim.lease_expires_at} />
                </td>
                <td className="table-cell">
                  {claim.state === 'active' && can('party:revoke') ? (
                    <button
                      type="button"
                      className="btn-secondary py-1 text-xs"
                      onClick={() =>
                        setRevoking({
                          id: claim.id,
                          label: `${claim.resource_type}:${claim.resource_key}`,
                        })
                      }
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="text-xs text-ink-500 dark:text-parchment-300/60">—</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {revoking !== null && (
        <Panel title="Revoke a claim">
          <div className="space-y-3 px-4 py-3">
            {/* An operator must not take away an active critical claim without confirming. */}
            <p className="rounded border border-rust-500/40 bg-rust-500/10 px-3 py-2 text-sm text-rust-700 dark:text-rust-400">
              Revoking <code className="font-mono text-xs">{revoking.label}</code> takes it from an
              agent that may still be using it. The agent will see the claim disappear on its next
              heartbeat. This is recorded in the audit log.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1">
                <label className="field-label" htmlFor="revoke-reason">
                  Reason (required)
                </label>
                <input
                  id="revoke-reason"
                  className="field-input"
                  autoFocus
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn-danger"
                disabled={reason.trim().length === 0 || revoke.isPending}
                onClick={() =>
                  revoke.mutate(
                    { claimId: revoking.id, reason },
                    {
                      onSuccess: () => {
                        setRevoking(null);
                        setReason('');
                      },
                    },
                  )
                }
              >
                Confirm revoke
              </button>
              <button type="button" className="btn-secondary" onClick={() => setRevoking(null)}>
                Cancel
              </button>
            </div>
            {revoke.isError && <ErrorState error={revoke.error} />}
          </div>
        </Panel>
      )}
    </div>
  );
}

function OverlapRow({ overlap }: { overlap: OverlapDto }) {
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[overlap.severity] ?? 'neutral'}>{overlap.severity}</Badge>
        <Badge tone="neutral">{overlap.kind}</Badge>
        {overlap.same_workspace && <Badge tone="bad">same workspace</Badge>}
        <span className="text-sm">{overlap.message}</span>
      </div>
      {overlap.values.length > 0 && (
        <p className="mt-1 font-mono text-xs text-ink-500 dark:text-parchment-300/60">
          {overlap.values.join(', ')}
        </p>
      )}
    </li>
  );
}
