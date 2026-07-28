import type {
  AgentRunState,
  ClaimMode,
  ClaimState,
  ResourcePolicy,
  ResourceType,
} from '@saga/contracts';
import type { Queryable } from '@saga/database';
import { isUniqueViolation } from '@saga/database';
import { SagaError } from '@saga/shared';

export interface AgentRun {
  id: string;
  projectId: string;
  sessionId: string;
  workItemId: string | null;
  agentInstanceId: string;
  client: string;
  workspaceKey: string | null;
  workspaceLabel: string | null;
  state: AgentRunState;
  heartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface Resource {
  id: string;
  projectId: string;
  resourceType: ResourceType;
  resourceKey: string;
  policy: ResourcePolicy;
  metadata: Record<string, unknown>;
}

export interface Claim {
  id: string;
  resourceId: string;
  resourceType: ResourceType;
  resourceKey: string;
  resourcePolicy: ResourcePolicy;
  agentRunId: string;
  workItemId: string;
  workItemTitle: string;
  client: string;
  mode: ClaimMode;
  state: ClaimState;
  baseFingerprint: string | null;
  acquiredAt: Date;
  leaseExpiresAt: Date;
  releasedAt: Date | null;
  releaseReason: string | null;
}

interface RunRow {
  id: string;
  project_id: string;
  session_id: string;
  work_item_id: string | null;
  agent_instance_id: string;
  client: string;
  workspace_key: string | null;
  workspace_label: string | null;
  state: string;
  heartbeat_at: Date | null;
  lease_expires_at: Date | null;
  started_at: Date;
  ended_at: Date | null;
}

const RUN_COLUMNS = `id, project_id, session_id, work_item_id, agent_instance_id, client,
                     workspace_key, workspace_label, state, heartbeat_at, lease_expires_at,
                     started_at, ended_at`;

function toRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    workItemId: row.work_item_id,
    agentInstanceId: row.agent_instance_id,
    client: row.client,
    workspaceKey: row.workspace_key,
    workspaceLabel: row.workspace_label,
    state: row.state as AgentRunState,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

interface ClaimRow {
  id: string;
  resource_id: string;
  resource_type: string;
  resource_key: string;
  resource_policy: string;
  agent_run_id: string;
  work_item_id: string;
  work_item_title: string;
  client: string;
  mode: string;
  state: string;
  base_fingerprint: string | null;
  acquired_at: Date;
  lease_expires_at: Date;
  released_at: Date | null;
  release_reason: string | null;
}

const CLAIM_SELECT = `SELECT c.id, c.resource_id, r.resource_type, r.resource_key,
                             r.policy AS resource_policy, c.agent_run_id, c.work_item_id,
                             w.title AS work_item_title, a.client, c.mode, c.state,
                             c.base_fingerprint, c.acquired_at, c.lease_expires_at,
                             c.released_at, c.release_reason
                        FROM party.claims c
                        JOIN party.resources r ON r.id = c.resource_id
                        JOIN party.agent_runs a ON a.id = c.agent_run_id
                        JOIN quest.work_items w ON w.id = c.work_item_id`;

function toClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    resourceId: row.resource_id,
    resourceType: row.resource_type as ResourceType,
    resourceKey: row.resource_key,
    resourcePolicy: row.resource_policy as ResourcePolicy,
    agentRunId: row.agent_run_id,
    workItemId: row.work_item_id,
    workItemTitle: row.work_item_title,
    client: row.client,
    mode: row.mode as ClaimMode,
    state: row.state as ClaimState,
    baseFingerprint: row.base_fingerprint,
    acquiredAt: row.acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

export class PartyRepository {
  // --- agent runs ----------------------------------------------------------

  async createRun(
    tx: Queryable,
    input: {
      projectId: string;
      sessionId: string;
      agentInstanceId: string;
      client: string;
      workspaceKey: string | null;
      workspaceLabel: string | null;
      leaseSeconds: number;
    },
  ): Promise<AgentRun> {
    const result = await tx.query<RunRow>(
      `INSERT INTO party.agent_runs
         (project_id, session_id, agent_instance_id, client, workspace_key, workspace_label,
          state, heartbeat_at, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', now(),
               now() + make_interval(secs => $7::double precision))
       RETURNING ${RUN_COLUMNS}`,
      [
        input.projectId,
        input.sessionId,
        input.agentInstanceId,
        input.client,
        input.workspaceKey,
        input.workspaceLabel,
        input.leaseSeconds,
      ],
    );
    return toRun(result.rows[0]!);
  }

  async findRunById(q: Queryable, id: string): Promise<AgentRun | null> {
    const result = await q.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM party.agent_runs WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toRun(result.rows[0]);
  }

  async findLiveRunForSession(q: Queryable, sessionId: string): Promise<AgentRun | null> {
    const result = await q.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM party.agent_runs
        WHERE session_id = $1 AND state NOT IN ('ended', 'expired')
        ORDER BY started_at DESC LIMIT 1`,
      [sessionId],
    );
    return result.rows[0] === undefined ? null : toRun(result.rows[0]);
  }

  /** Renew the lease. Returns null when the run already ended or expired. */
  async heartbeat(
    q: Queryable,
    id: string,
    input: { state?: 'active' | 'waiting'; workItemId?: string | null; leaseSeconds: number },
  ): Promise<AgentRun | null> {
    const assignments = [
      'heartbeat_at = now()',
      'lease_expires_at = now() + make_interval(secs => $2::double precision)',
    ];
    const values: unknown[] = [id, input.leaseSeconds];
    if (input.state !== undefined) {
      values.push(input.state);
      assignments.push(`state = $${values.length}`);
    }
    if (input.workItemId !== undefined) {
      values.push(input.workItemId);
      assignments.push(`work_item_id = $${values.length}`);
    }

    const result = await q.query<RunRow>(
      `UPDATE party.agent_runs SET ${assignments.join(', ')}
        WHERE id = $1 AND state NOT IN ('ended', 'expired')
       RETURNING ${RUN_COLUMNS}`,
      values,
    );
    return result.rows[0] === undefined ? null : toRun(result.rows[0]);
  }

  async attachQuest(q: Queryable, sessionId: string, workItemId: string): Promise<void> {
    await q.query(
      `UPDATE party.agent_runs SET work_item_id = $2
        WHERE session_id = $1 AND state NOT IN ('ended', 'expired')`,
      [sessionId, workItemId],
    );
  }

  async endRun(tx: Queryable, id: string, state: 'ended' | 'expired'): Promise<AgentRun | null> {
    const result = await tx.query<RunRow>(
      `UPDATE party.agent_runs
          SET state = $2, ended_at = now(), lease_expires_at = NULL
        WHERE id = $1 AND state NOT IN ('ended', 'expired')
       RETURNING ${RUN_COLUMNS}`,
      [id, state],
    );
    return result.rows[0] === undefined ? null : toRun(result.rows[0]);
  }

  async listLiveRuns(q: Queryable, projectId: string): Promise<AgentRun[]> {
    const result = await q.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM party.agent_runs
        WHERE project_id = $1 AND state NOT IN ('ended', 'expired') AND lease_expires_at > now()
        ORDER BY started_at`,
      [projectId],
    );
    return result.rows.map(toRun);
  }

  async listRuns(q: Queryable, projectId: string, limit: number): Promise<AgentRun[]> {
    const result = await q.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM party.agent_runs
        WHERE project_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(toRun);
  }

  /** Runs whose lease lapsed while they were still marked live. */
  async findExpiredRuns(tx: Queryable, limit: number): Promise<AgentRun[]> {
    const result = await tx.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM party.agent_runs
        WHERE state NOT IN ('ended', 'expired') AND lease_expires_at < now()
        ORDER BY lease_expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return result.rows.map(toRun);
  }

  async countLive(q: Queryable): Promise<number> {
    const result = await q.query<{ count: string }>(
      `SELECT count(*)::text FROM party.agent_runs
        WHERE state NOT IN ('ended','expired') AND lease_expires_at > now()`,
    );
    return Number(result.rows[0]!.count);
  }

  async countLiveByProject(
    q: Queryable,
    projectIds: readonly string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (projectIds.length === 0) return map;
    const result = await q.query<{ project_id: string; count: string }>(
      `SELECT project_id, count(*)::text AS count FROM party.agent_runs
        WHERE project_id = ANY($1::uuid[])
          AND state NOT IN ('ended','expired') AND lease_expires_at > now()
        GROUP BY project_id`,
      [[...projectIds]],
    );
    for (const row of result.rows) map.set(row.project_id, Number(row.count));
    return map;
  }

  // --- resources -----------------------------------------------------------

  /**
   * Find-or-create the resource, then lock it `FOR UPDATE`.
   *
   * Locking the resource row is what serialises concurrent claim attempts: everything after
   * this point in the transaction sees a stable view of the claims on it.
   */
  async lockOrCreateResource(
    tx: Queryable,
    input: {
      projectId: string;
      resourceType: ResourceType;
      resourceKey: string;
      policy: ResourcePolicy;
    },
  ): Promise<Resource> {
    const existing = await tx.query<{
      id: string;
      project_id: string;
      resource_type: string;
      resource_key: string;
      policy: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, project_id, resource_type, resource_key, policy, metadata
         FROM party.resources
        WHERE project_id = $1 AND resource_type = $2 AND resource_key = $3
        FOR UPDATE`,
      [input.projectId, input.resourceType, input.resourceKey],
    );

    if (existing.rows[0] !== undefined) {
      const row = existing.rows[0];
      return {
        id: row.id,
        projectId: row.project_id,
        resourceType: row.resource_type as ResourceType,
        resourceKey: row.resource_key,
        policy: row.policy as ResourcePolicy,
        metadata: row.metadata,
      };
    }

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO party.resources (project_id, resource_type, resource_key, policy)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, resource_type, resource_key) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [input.projectId, input.resourceType, input.resourceKey, input.policy],
    );

    // Re-select FOR UPDATE so the row lock is held even on the insert path.
    const locked = await tx.query<{
      id: string;
      project_id: string;
      resource_type: string;
      resource_key: string;
      policy: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, project_id, resource_type, resource_key, policy, metadata
         FROM party.resources WHERE id = $1 FOR UPDATE`,
      [inserted.rows[0]!.id],
    );
    const row = locked.rows[0]!;
    return {
      id: row.id,
      projectId: row.project_id,
      resourceType: row.resource_type as ResourceType,
      resourceKey: row.resource_key,
      policy: row.policy as ResourcePolicy,
      metadata: row.metadata,
    };
  }

  async listResources(q: Queryable, projectId: string): Promise<Resource[]> {
    const result = await q.query<{
      id: string;
      project_id: string;
      resource_type: string;
      resource_key: string;
      policy: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, project_id, resource_type, resource_key, policy, metadata
         FROM party.resources WHERE project_id = $1 ORDER BY resource_type, resource_key`,
      [projectId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      resourceType: row.resource_type as ResourceType,
      resourceKey: row.resource_key,
      policy: row.policy as ResourcePolicy,
      metadata: row.metadata,
    }));
  }

  // --- claims --------------------------------------------------------------

  /** Expire lapsed claims on one resource. Must run inside the resource row lock. */
  async expireStaleClaims(tx: Queryable, resourceId: string): Promise<number> {
    const result = await tx.query(
      `UPDATE party.claims
          SET state = 'expired', released_at = now(),
              release_reason = 'The claim lease expired.'
        WHERE resource_id = $1 AND state = 'active' AND lease_expires_at <= now()`,
      [resourceId],
    );
    return result.rowCount ?? 0;
  }

  async listActiveClaimsForResource(tx: Queryable, resourceId: string): Promise<Claim[]> {
    const result = await tx.query<ClaimRow>(
      `${CLAIM_SELECT} WHERE c.resource_id = $1 AND c.state = 'active' ORDER BY c.acquired_at`,
      [resourceId],
    );
    return result.rows.map(toClaim);
  }

  async insertClaim(
    tx: Queryable,
    input: {
      resourceId: string;
      agentRunId: string;
      workItemId: string;
      mode: ClaimMode;
      baseFingerprint: string | null;
      leaseSeconds: number;
    },
  ): Promise<Claim> {
    try {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO party.claims
           (resource_id, agent_run_id, work_item_id, mode, base_fingerprint, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::double precision))
         RETURNING id`,
        [
          input.resourceId,
          input.agentRunId,
          input.workItemId,
          input.mode,
          input.baseFingerprint,
          input.leaseSeconds,
        ],
      );
      const claim = await this.findClaimById(tx, inserted.rows[0]!.id);
      if (claim === null)
        throw new SagaError('INTERNAL_ERROR', 'The claim vanished after insertion.');
      return claim;
    } catch (error) {
      if (isUniqueViolation(error, 'claims_one_exclusive_per_resource')) {
        // The partial unique index is the database-level backstop for the row lock.
        throw new SagaError(
          'RESOURCE_CLAIM_CONFLICT',
          'Another agent holds an exclusive claim on this resource.',
        );
      }
      throw error;
    }
  }

  async findClaimById(q: Queryable, id: string): Promise<Claim | null> {
    const result = await q.query<ClaimRow>(`${CLAIM_SELECT} WHERE c.id = $1`, [id]);
    return result.rows[0] === undefined ? null : toClaim(result.rows[0]);
  }

  async lockClaimById(tx: Queryable, id: string): Promise<Claim | null> {
    // Lock the claim row itself; the join columns are read-only here.
    await tx.query(`SELECT 1 FROM party.claims WHERE id = $1 FOR UPDATE`, [id]);
    return this.findClaimById(tx, id);
  }

  async releaseClaim(
    tx: Queryable,
    id: string,
    state: 'released' | 'revoked',
    reason: string | null,
  ): Promise<Claim | null> {
    const result = await tx.query<{ id: string }>(
      `UPDATE party.claims
          SET state = $2, released_at = now(), release_reason = $3
        WHERE id = $1 AND state = 'active'
       RETURNING id`,
      [id, state, reason],
    );
    if (result.rows[0] === undefined) return null;
    return this.findClaimById(tx, id);
  }

  async renewClaim(q: Queryable, id: string, leaseSeconds: number): Promise<boolean> {
    const result = await q.query(
      `UPDATE party.claims
          SET lease_expires_at = now() + make_interval(secs => $2::double precision)
        WHERE id = $1 AND state = 'active'`,
      [id, leaseSeconds],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** Renew every active claim held by an agent run, following its heartbeat. */
  async renewClaimsForRun(q: Queryable, agentRunId: string, leaseSeconds: number): Promise<number> {
    const result = await q.query(
      `UPDATE party.claims
          SET lease_expires_at = now() + make_interval(secs => $2::double precision)
        WHERE agent_run_id = $1 AND state = 'active'`,
      [agentRunId, leaseSeconds],
    );
    return result.rowCount ?? 0;
  }

  async releaseClaimsForRun(tx: Queryable, agentRunId: string, reason: string): Promise<number> {
    const result = await tx.query(
      `UPDATE party.claims
          SET state = 'released', released_at = now(), release_reason = $2
        WHERE agent_run_id = $1 AND state = 'active'`,
      [agentRunId, reason],
    );
    return result.rowCount ?? 0;
  }

  async listClaimsForRun(q: Queryable, agentRunId: string): Promise<Claim[]> {
    const result = await q.query<ClaimRow>(
      `${CLAIM_SELECT} WHERE c.agent_run_id = $1 AND c.state = 'active' ORDER BY c.acquired_at`,
      [agentRunId],
    );
    return result.rows.map(toClaim);
  }

  async listClaimsForProject(
    q: Queryable,
    projectId: string,
    includeFinished: boolean,
  ): Promise<Claim[]> {
    const result = await q.query<ClaimRow>(
      `${CLAIM_SELECT}
        WHERE r.project_id = $1 ${includeFinished ? '' : `AND c.state = 'active'`}
        ORDER BY c.acquired_at DESC LIMIT 200`,
      [projectId],
    );
    return result.rows.map(toClaim);
  }

  async countActiveClaims(q: Queryable): Promise<number> {
    const result = await q.query<{ count: string }>(
      `SELECT count(*)::text FROM party.claims WHERE state = 'active' AND lease_expires_at > now()`,
    );
    return Number(result.rows[0]!.count);
  }

  // --- fingerprints --------------------------------------------------------

  async recordFingerprints(
    tx: Queryable,
    input: {
      projectId: string;
      workItemId: string;
      agentRunId: string | null;
      files: readonly { path: string; baseHash?: string; currentHash?: string }[];
    },
  ): Promise<number> {
    let recorded = 0;
    for (const file of input.files) {
      await tx.query(
        `INSERT INTO party.file_fingerprints
           (project_id, work_item_id, agent_run_id, path, base_hash, current_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (work_item_id, path) DO UPDATE
           SET current_hash = EXCLUDED.current_hash,
               base_hash = COALESCE(party.file_fingerprints.base_hash, EXCLUDED.base_hash),
               agent_run_id = EXCLUDED.agent_run_id,
               observed_at = now()`,
        [
          input.projectId,
          input.workItemId,
          input.agentRunId,
          file.path,
          file.baseHash ?? null,
          file.currentHash ?? null,
        ],
      );
      recorded += 1;
    }
    return recorded;
  }

  /** Fingerprints recorded by *other* Quests for the same paths. */
  async findConflictingFingerprints(
    q: Queryable,
    input: { projectId: string; workItemId: string; paths: readonly string[] },
  ): Promise<
    { path: string; currentHash: string | null; workItemId: string; workItemTitle: string }[]
  > {
    if (input.paths.length === 0) return [];
    const result = await q.query<{
      path: string;
      current_hash: string | null;
      work_item_id: string;
      title: string;
    }>(
      `SELECT f.path, f.current_hash, f.work_item_id, w.title
         FROM party.file_fingerprints f
         JOIN quest.work_items w ON w.id = f.work_item_id
        WHERE f.project_id = $1
          AND f.work_item_id <> $2
          AND f.path = ANY($3::text[])
          AND w.status NOT IN ('completed', 'cancelled')
        ORDER BY f.observed_at DESC`,
      [input.projectId, input.workItemId, [...input.paths]],
    );
    return result.rows.map((row) => ({
      path: row.path,
      currentHash: row.current_hash,
      workItemId: row.work_item_id,
      workItemTitle: row.title,
    }));
  }

  async listChangedFilesForRuns(
    q: Queryable,
    workItemIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (workItemIds.length === 0) return map;
    const result = await q.query<{ work_item_id: string; path: string }>(
      `SELECT work_item_id, path FROM party.file_fingerprints
        WHERE work_item_id = ANY($1::uuid[]) ORDER BY path`,
      [[...workItemIds]],
    );
    for (const row of result.rows) {
      const list = map.get(row.work_item_id) ?? [];
      list.push(row.path);
      map.set(row.work_item_id, list);
    }
    return map;
  }
}
