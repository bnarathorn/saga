import type { AgentTokenDto } from '@saga/contracts';
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
} from '../components/primitives.jsx';
import { useCan } from '../lib/permissions.jsx';
import { useProjectTokens, useRevokeAgentToken } from '../lib/queries.js';

/**
 * A project's agent tokens, with revocation.
 *
 * Creation deliberately lives elsewhere: `saga connect` mints a token through the device flow and
 * hands the raw value straight to the CLI, which stores it in the operating-system keychain. This
 * page never renders a secret — `token_prefix` is derived from the token's *hash*, not the token,
 * so it is safe to display for as long as the row exists.
 *
 * See ADR-0009 for why this tab exists at all.
 */

type TokenState = 'active' | 'expired' | 'revoked';

/**
 * A token is dead in two different ways, and only one of them sets a column.
 * `AgentTokenRepository.authenticate` accepts a token only while
 * `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, so a token past its expiry
 * is already refused while `revoked_at` is still null. Offering Revoke on one of those would
 * succeed and write an audit record for killing something that was already dead.
 */
function tokenState(token: AgentTokenDto, now: number): TokenState {
  if (token.revoked_at !== null) return 'revoked';
  if (token.expires_at !== null && Date.parse(token.expires_at) <= now) return 'expired';
  return 'active';
}

const STATE_TONE = { active: 'good', expired: 'neutral', revoked: 'bad' } as const;

export function ProjectTokensPage() {
  const { projectRef = '' } = useParams();
  const can = useCan();
  const allowed = can('security:manage');

  // A caller without the permission issues no request at all: the API would refuse it, and a
  // 403 in the network log is a worse explanation than the one below.
  const tokens = useProjectTokens(projectRef, allowed);
  const revoke = useRevokeAgentToken();

  const [showRevoked, setShowRevoked] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; label: string } | null>(null);
  const [reason, setReason] = useState('');

  if (!allowed) {
    return (
      <Panel title="Agent tokens">
        <div className="px-4 py-8 text-sm text-ink-600 dark:text-parchment-300/80">
          Listing and revoking agent tokens takes the{' '}
          <code className="font-mono text-xs">security:manage</code> permission. Ask an
          administrator.
        </div>
      </Panel>
    );
  }

  const now = Date.now();
  const items = tokens.data?.items ?? [];
  const visible = showRevoked
    ? items
    : items.filter((token) => tokenState(token, now) !== 'revoked');

  return (
    <div className="space-y-6">
      <Panel
        title="Agent tokens"
        actions={
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={showRevoked}
              onChange={(event) => setShowRevoked(event.target.checked)}
            />
            <span>Show revoked</span>
          </label>
        }
      >
        {tokens.isPending && <LoadingState label="Loading tokens…" />}
        {tokens.isError && (
          <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
        )}
        {tokens.data !== undefined && items.length === 0 && (
          <EmptyState
            title="No agent tokens yet"
            description="Run `saga connect` from a project folder, then approve the request."
          />
        )}
        {/* Revoked tokens are never deleted, so a project can hold rows while showing none. */}
        {tokens.data !== undefined && items.length > 0 && visible.length === 0 && (
          <EmptyState
            title="Every token here is revoked"
            description="Tick “Show revoked” to see them."
          />
        )}
        {tokens.data !== undefined && visible.length > 0 && (
          <Table
            headers={['Name', 'Prefix', 'Scopes', 'Created', 'Last used', 'Expires', 'State', '']}
          >
            {visible.map((token) => {
              const state = tokenState(token, now);
              return (
                <tr key={token.id}>
                  <td className="table-cell">{token.name}</td>
                  {/* Tokens minted by the device flow share one name per project, so the prefix
                      and the timestamps are what actually tell two rows apart. */}
                  <td className="table-cell font-mono text-xs">{token.token_prefix}</td>
                  <td className="table-cell text-xs">{token.scopes.join(', ')}</td>
                  <td className="table-cell whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
                    <RelativeTime value={token.created_at} />
                  </td>
                  <td className="table-cell whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
                    <RelativeTime value={token.last_used_at} />
                  </td>
                  <td className="table-cell whitespace-nowrap">
                    {token.expires_at === null ? (
                      <Badge tone="warn">never</Badge>
                    ) : (
                      <RelativeTime value={token.expires_at} />
                    )}
                  </td>
                  <td className="table-cell">
                    <Badge tone={STATE_TONE[state]}>{state}</Badge>
                  </td>
                  <td className="table-cell">
                    {state === 'active' ? (
                      <button
                        type="button"
                        className="btn-secondary py-1 text-xs"
                        onClick={() => {
                          setRevoking({ id: token.id, label: token.token_prefix });
                          setReason('');
                        }}
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
        )}
      </Panel>

      {revoking !== null && (
        <Panel title="Revoke a token">
          <div className="space-y-3 px-4 py-3">
            <p className="rounded border border-rust-500/40 bg-rust-500/10 px-3 py-2 text-sm text-rust-700 dark:text-rust-400">
              Revoking <code className="font-mono text-xs">{revoking.label}</code> takes effect
              immediately and cannot be undone. Any agent still holding it fails its next request,
              and reconnecting means running <code className="font-mono text-xs">saga connect</code>{' '}
              again. This is recorded in the audit log.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1">
                <label className="field-label" htmlFor="revoke-token-reason">
                  Reason (required)
                </label>
                <input
                  id="revoke-token-reason"
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
                    { id: revoking.id, reason },
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
