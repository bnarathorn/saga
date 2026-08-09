import type { AgentScope } from '@saga/contracts';
import { AGENT_SCOPES } from '@saga/contracts/constants';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  RelativeTime,
  Table,
} from '../components/primitives.jsx';
import { ApiError } from '../lib/api.js';
import { useCan } from '../lib/permissions.jsx';
import { useApproveDevice, useDevicePending, useProjects } from '../lib/queries.js';

/**
 * Every agent scope except `lore:publish` — the working set an agent needs to read Lore,
 * propose changes, work Quests and hold Party claims, without the ability to publish Lore
 * unattended. Spec 12.1 leaves the actual grant to the approving administrator; this is only
 * the starting point they see checked.
 */
const DEFAULT_SCOPES: readonly AgentScope[] = AGENT_SCOPES.filter(
  (scope) => scope !== 'lore:publish',
);

/**
 * Step 2/3 of the CLI device flow (spec 12.1): `saga connect` prints or opens
 * `verification_uri_complete`, which `auth-service.ts` builds as `${verificationUri}?code=…`.
 * This page is what that URL points at — a signed-in administrator reads the pending request
 * here, picks the project it belongs to, and approves it. The CLI itself never chooses the
 * project; that choice is made here, by a human, on purpose.
 */
export function DevicePage() {
  const can = useCan();
  const allowed = can('security:manage');

  // The query parameter name comes from how `verification_uri_complete` is built, not a guess.
  const [searchParams] = useSearchParams();
  const codeFromUrl = searchParams.get('code') ?? '';

  const pending = useDevicePending(allowed);
  // Only an active project can receive a new agent token; an archived one has nothing to
  // resume work on. The limit is explicit and set to the query schema's maximum
  // (`listProjectsQuerySchema`, packages/contracts/src/projects.ts) because the server's
  // default page size is 50 — past that many active projects, the one an administrator needs
  // would silently be missing from the dropdown.
  const projects = useProjects('?status=active&limit=200', allowed);
  const approve = useApproveDevice();

  const [userCode, setUserCode] = useState(codeFromUrl);
  const [projectRef, setProjectRef] = useState('');
  const [tokenName, setTokenName] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>([...DEFAULT_SCOPES]);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [approved, setApproved] = useState<{ name: string; token_prefix: string } | null>(null);

  if (!allowed) {
    return (
      <Panel title="Approve a device sign-in">
        <div className="px-4 py-8 text-sm text-ink-600 dark:text-parchment-300/80">
          Approving a device request takes the{' '}
          <code className="font-mono text-xs">security:manage</code> permission. Ask an
          administrator to open this link instead.
        </div>
      </Panel>
    );
  }

  const toggleScope = (scope: AgentScope) => {
    setScopes((current) =>
      current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope],
    );
  };

  const ready = userCode.trim().length > 0 && projectRef.length > 0 && scopes.length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Belt and suspenders: the submit button is already disabled while a request is in
    // flight, but a second Enter-key submit reaches this handler directly.
    if (!ready || approve.isPending) return;
    const days = expiresInDays.trim();
    approve.mutate(
      {
        user_code: userCode.trim(),
        project_ref: projectRef,
        token_name: tokenName.trim().length > 0 ? tokenName.trim() : undefined,
        scopes,
        expires_in_days: days.length > 0 ? Number(days) : undefined,
      },
      {
        onSuccess: (result) => {
          setApproved({ name: result.token.name, token_prefix: result.token.token_prefix });
          setUserCode('');
          setProjectRef('');
          setTokenName('');
          setScopes([...DEFAULT_SCOPES]);
          setExpiresInDays('');
        },
      },
    );
  };

  const approveError = approve.error instanceof ApiError ? approve.error : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink-800 dark:text-parchment-100">
          Approve a device sign-in
        </h1>
        <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
          `saga connect` printed a code and opened this page. Confirm the code matches what the CLI
          is showing, then pick the project it should work in.
        </p>
      </div>

      <Panel title="Pending requests">
        {pending.isPending && <LoadingState />}
        {pending.isError && (
          <ErrorState error={pending.error} onRetry={() => void pending.refetch()} />
        )}
        {pending.data?.items.length === 0 && (
          <EmptyState
            title="No device requests are waiting"
            description="Run `saga connect` from the CLI, then reload this page."
          />
        )}
        {pending.data !== undefined && pending.data.items.length > 0 && (
          <Table headers={['Code', 'Client', 'Workspace', 'Requested scopes', 'Expires', '']}>
            {pending.data.items.map((item) => (
              <tr key={item.user_code}>
                <td className="table-cell font-mono text-xs">{item.user_code}</td>
                <td className="table-cell">{item.client}</td>
                <td className="table-cell text-xs text-ink-500 dark:text-parchment-300/60">
                  {item.workspace_label ?? '—'}
                </td>
                <td className="table-cell text-xs">{item.requested_scopes.join(', ')}</td>
                <td className="table-cell whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
                  <RelativeTime value={item.expires_at} />
                </td>
                <td className="table-cell">
                  <button
                    type="button"
                    className="btn-secondary py-1 text-xs"
                    onClick={() => setUserCode(item.user_code)}
                  >
                    Use this code
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Panel title="Approve">
        {projects.isPending && <LoadingState />}

        {projects.isError && <ErrorState error={projects.error} />}

        {!projects.isPending && !projects.isError && projects.data?.items.length === 0 && (
          // Every agent token is bound to a project, so there is nothing to approve into until
          // one exists — showing the form here would just be a permanently disabled button with
          // no explanation of why.
          <EmptyState
            title="No active projects"
            description="An agent token must belong to a project. Create one on the Projects page, then come back to approve this request."
          />
        )}

        {!projects.isPending && !projects.isError && (projects.data?.items.length ?? 0) > 0 && (
          <>
            <form className="space-y-4 px-4 py-4" onSubmit={submit}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="device-code">
                    Device code
                  </label>
                  <input
                    id="device-code"
                    className="field-input font-mono"
                    value={userCode}
                    onChange={(event) => setUserCode(event.target.value)}
                    placeholder="ABCD-1234"
                    required
                  />
                </div>

                <div>
                  <label className="field-label" htmlFor="device-project">
                    Project
                  </label>
                  <select
                    id="device-project"
                    className="field-input"
                    value={projectRef}
                    onChange={(event) => setProjectRef(event.target.value)}
                    required
                  >
                    <option value="">Select a project…</option>
                    {projects.data?.items.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="field-label" htmlFor="device-token-name">
                    Token name
                  </label>
                  <input
                    id="device-token-name"
                    className="field-input"
                    value={tokenName}
                    onChange={(event) => setTokenName(event.target.value)}
                    placeholder="Defaults to “<project> agent”"
                  />
                </div>

                <div>
                  <label className="field-label" htmlFor="device-expires">
                    Expires in (days, optional)
                  </label>
                  <input
                    id="device-expires"
                    className="field-input"
                    type="number"
                    min={1}
                    max={3_650}
                    value={expiresInDays}
                    onChange={(event) => setExpiresInDays(event.target.value)}
                    placeholder="Never"
                  />
                </div>
              </div>

              <fieldset>
                <legend className="field-label">Scopes</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {AGENT_SCOPES.map((scope) => (
                    <label key={scope} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      <span className="font-mono text-xs">{scope}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <button type="submit" className="btn-primary" disabled={!ready || approve.isPending}>
                {approve.isPending ? 'Approving…' : 'Approve'}
              </button>
            </form>

            {approveError !== null && (
              <p
                role="alert"
                className="px-4 pb-4 text-sm font-medium text-rust-600 dark:text-rust-400"
              >
                {approveError.message}
              </p>
            )}

            {approved !== null && (
              <p className="px-4 pb-4 text-sm text-moss-600 dark:text-moss-400">
                Approved <span className="font-mono text-xs">{approved.name}</span> (
                {approved.token_prefix}…). The CLI will collect its token on its next poll.
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
