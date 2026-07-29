import type { ClaimDto } from '@saga/contracts';
import { isLeaseLapsed, useReleaseClaim } from '../lib/party-queries.js';
import { useCan } from '../lib/permissions.jsx';
import { Badge, ErrorState, RelativeTime, Table, type BadgeTone } from './primitives.jsx';

const CLAIM_TONE: Record<string, BadgeTone> = {
  active: 'good',
  released: 'neutral',
  expired: 'warn',
  revoked: 'bad',
};

const RELEASE_REASON = 'Released from Guild Hall after the lease lapsed.';

/**
 * The claims view of spec 16.6, reused on Quest Detail. Releasing a lapsed claim is handled
 * here because it needs no confirmation — the lease has already run out, so nothing live is
 * being taken away. Revocation does need confirmation and a reason, so the owning page keeps it.
 */
export function ClaimsTable({
  claims,
  onRevoke,
}: {
  claims: ClaimDto[];
  onRevoke?: (claim: ClaimDto) => void;
}) {
  const can = useCan();
  const release = useReleaseClaim();
  const now = Date.now();

  return (
    <>
      <Table headers={['Resource', 'Policy', 'Mode', 'Owner', 'State', 'Lease', 'Actions']}>
        {claims.map((claim) => {
          const lapsed = isLeaseLapsed(claim, now);
          return (
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
                {lapsed && (
                  <span className="ml-1">
                    <Badge tone="warn">lease lapsed</Badge>
                  </span>
                )}
              </td>
              <td className="table-cell whitespace-nowrap text-xs text-ink-500 dark:text-parchment-300/70">
                <RelativeTime value={claim.lease_expires_at} />
              </td>
              <td className="table-cell">
                {lapsed && can('party:claim') ? (
                  <button
                    type="button"
                    className="btn-secondary py-1 text-xs"
                    disabled={release.isPending}
                    onClick={() =>
                      release.mutate({
                        claimId: claim.id,
                        agentRunId: claim.agent_run_id,
                        reason: RELEASE_REASON,
                      })
                    }
                  >
                    Release
                  </button>
                ) : claim.state === 'active' && onRevoke !== undefined && can('party:revoke') ? (
                  <button
                    type="button"
                    className="btn-secondary py-1 text-xs"
                    onClick={() => onRevoke(claim)}
                  >
                    Revoke
                  </button>
                ) : (
                  <span className="text-xs text-ink-500 dark:text-parchment-300/60">—</span>
                )}
              </td>
            </tr>
          );
        })}
      </Table>
      {release.isError && <ErrorState error={release.error} />}
    </>
  );
}
