import type { OverlapDto, QuestScope } from '@saga/contracts';

/**
 * Overlap detection (spec 10.3).
 *
 * Saga warns and coordinates; it never merges files. The output is deliberately concise —
 * an agent's context budget is small, and a wall of overlap noise would be ignored.
 */
export interface AgentSnapshot {
  agentRunId: string;
  sessionId: string;
  client: string;
  workspaceKey: string | null;
  workItemId: string | null;
  questTitle: string | null;
  scope: QuestScope;
  claims: { resourceType: string; resourceKey: string; mode: string }[];
  changedFiles: string[];
}

const SCOPE_FIELDS: { field: keyof QuestScope; kind: OverlapDto['kind']; label: string }[] = [
  { field: 'modules', kind: 'module', label: 'module' },
  { field: 'files', kind: 'file', label: 'file' },
  { field: 'components', kind: 'component', label: 'component' },
  { field: 'apis', kind: 'api', label: 'API' },
  { field: 'databases', kind: 'database', label: 'database' },
];

/**
 * Compare one agent against its peers.
 *
 * Two agents in the *same workspace* are escalated: uncommitted edits are immediately visible
 * to both, so an overlap there is a live hazard rather than a coordination note.
 */
export function detectOverlaps(subject: AgentSnapshot, peers: readonly AgentSnapshot[]): OverlapDto[] {
  const overlaps: OverlapDto[] = [];

  for (const peer of peers) {
    if (peer.agentRunId === subject.agentRunId) continue;
    // Two agent runs serving the same Quest are collaborating, not colliding.
    if (peer.workItemId !== null && peer.workItemId === subject.workItemId) continue;

    const sameWorkspace =
      subject.workspaceKey !== null &&
      peer.workspaceKey !== null &&
      subject.workspaceKey === peer.workspaceKey;

    const base = {
      other_agent_run_id: peer.agentRunId,
      other_client: peer.client,
      other_quest_id: peer.workItemId,
      other_quest_title: peer.questTitle,
      same_workspace: sameWorkspace,
    };

    if (sameWorkspace) {
      overlaps.push({
        ...base,
        kind: 'workspace',
        severity: 'critical',
        message: `${peer.client} is working in the same folder. Uncommitted changes are visible to both agents immediately.`,
        values: [],
      });
    }

    for (const { field, kind, label } of SCOPE_FIELDS) {
      const shared = intersect(subject.scope[field], peer.scope[field]);
      if (shared.length === 0) continue;
      overlaps.push({
        ...base,
        kind,
        severity: sameWorkspace ? 'critical' : 'warning',
        message: `${peer.client} declared the same ${label}${shared.length === 1 ? '' : 's'} on "${peer.questTitle ?? 'another Quest'}".`,
        values: shared.slice(0, 10),
      });
    }

    const sharedFiles = intersect(subject.changedFiles, peer.changedFiles);
    if (sharedFiles.length > 0) {
      overlaps.push({
        ...base,
        kind: 'file',
        severity: 'critical',
        message: `${peer.client} has already changed ${sharedFiles.length} of the same file${sharedFiles.length === 1 ? '' : 's'}.`,
        values: sharedFiles.slice(0, 10),
      });
    }

    const sharedClaims = peer.claims.filter((peerClaim) =>
      subject.claims.some(
        (own) =>
          own.resourceType === peerClaim.resourceType && own.resourceKey === peerClaim.resourceKey,
      ),
    );
    if (sharedClaims.length > 0) {
      overlaps.push({
        ...base,
        kind: 'claim',
        severity: 'warning',
        message: `${peer.client} holds a claim on the same resource${sharedClaims.length === 1 ? '' : 's'}.`,
        values: sharedClaims.map((claim) => `${claim.resourceType}:${claim.resourceKey}`).slice(0, 10),
      });
    }
  }

  // Most severe first. Within a severity, a shared workspace leads: it is the condition that
  // makes every other overlap on the list more dangerous, so an agent must read it first.
  const severityRank = { critical: 0, warning: 1, info: 2 };
  const kindRank: Record<OverlapDto['kind'], number> = {
    workspace: 0,
    file: 1,
    claim: 2,
    module: 3,
    component: 4,
    api: 5,
    database: 6,
  };
  return overlaps.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      kindRank[a.kind] - kindRank[b.kind] ||
      a.other_agent_run_id.localeCompare(b.other_agent_run_id),
  );
}

function intersect(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] {
  if (a === undefined || b === undefined) return [];
  const other = new Set(b);
  return [...new Set(a.filter((value) => other.has(value)))].sort();
}

/**
 * Render the Party section of agent context (spec 10.6): only what a peer needs to avoid a
 * collision, never every checkpoint from every agent.
 */
export function renderPartyContext(
  peers: readonly AgentSnapshot[],
  overlaps: readonly OverlapDto[],
  claims: readonly { resourceType: string; resourceKey: string; mode: string; questTitle: string; leaseExpiresAt: Date }[],
): string {
  if (peers.length === 0 && claims.length === 0) return '';

  const lines: string[] = [];

  if (peers.length > 0) {
    lines.push('## Parallel work', '');
    for (const peer of peers) {
      lines.push(`- ${peer.client}: ${peer.questTitle ?? 'no Quest attached'}`);
      const scopeParts: string[] = [];
      for (const { field, label } of SCOPE_FIELDS) {
        const values = peer.scope[field];
        if (values !== undefined && values.length > 0) {
          scopeParts.push(`${label}s ${values.slice(0, 3).join(', ')}`);
        }
      }
      if (scopeParts.length > 0) lines.push(`  Scope: ${scopeParts.join('; ')}`);
      if (peer.claims.length > 0) {
        lines.push(
          `  Claims: ${peer.claims.map((claim) => `${claim.resourceType}:${claim.resourceKey}`).join(', ')}`,
        );
      }
    }
    lines.push('');
  }

  if (overlaps.length > 0) {
    lines.push('## Overlap warnings', '');
    for (const overlap of overlaps.slice(0, 8)) {
      const values = overlap.values.length === 0 ? '' : ` (${overlap.values.slice(0, 5).join(', ')})`;
      lines.push(`- [${overlap.severity}] ${overlap.message}${values}`);
    }
    lines.push('');
  }

  if (claims.length > 0) {
    lines.push('## Claims', '');
    for (const claim of claims) {
      lines.push(
        `- ${claim.resourceType}:${claim.resourceKey} — ${claim.mode} — held for "${claim.questTitle}" until ${claim.leaseExpiresAt.toISOString()}`,
      );
    }
  }

  return lines.join('\n').trimEnd();
}

/**
 * Build the sanitised workspace label shown in Guild Hall. Absolute paths are never exposed
 * to broad audiences (spec 10.2), so a caller-supplied label is truncated and stripped of
 * path separators; anything that still looks like a path is replaced.
 */
export function sanitizeWorkspaceLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/') || /^[A-Za-z]:\\/.test(trimmed)) {
    // An absolute path was supplied; keep only the last segment.
    const segments = trimmed.split(/[/\\]/).filter((segment) => segment.length > 0);
    return segments.at(-1)?.slice(0, 60) ?? null;
  }
  return trimmed.slice(0, 60);
}
