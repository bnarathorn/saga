import type {
  ClaimMode,
  FingerprintConflictDto,
  OverlapDto,
  PartyMode,
  ResourceType,
} from '@saga/contracts';
import type { OutboxRepository } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import { SagaError } from '@saga/shared';
import type { QuestRepository } from '@saga/quest';
import {
  detectOverlaps,
  renderPartyContext,
  sanitizeWorkspaceLabel,
  type AgentSnapshot,
} from '../domain/overlap.js';
import {
  coordinationUnavailableGuidance,
  decideClaim,
  defaultPolicyFor,
  isFailClosed,
} from '../domain/policy.js';
import type { AgentRun, Claim } from '../repositories/party-repository.js';
import { type PartyRepository } from '../repositories/party-repository.js';

export interface PartyServiceDeps {
  pool: SagaPool;
  party: PartyRepository;
  quests: QuestRepository;
  outbox: OutboxRepository;
  mode: PartyMode;
  agentRunLeaseSeconds: number;
  claimLeaseSeconds: number;
}

export interface AcquireResult {
  claim: Claim;
  warnings: string[];
  alreadyHeld: boolean;
}

/**
 * Live coordination. Every write here is leased, so a crashed agent leaves expired rows
 * rather than a stuck lock, and nothing in this service is required for Lore or Quest.
 */
export class PartyService {
  constructor(private readonly deps: PartyServiceDeps) {}

  get mode(): PartyMode {
    return this.deps.mode;
  }

  get enabled(): boolean {
    return this.deps.mode !== 'off';
  }

  // --- agent runs ----------------------------------------------------------

  async startRun(input: {
    projectId: string;
    sessionId: string;
    agentInstanceId: string;
    client: string;
    workspaceKey?: string | null;
    workspaceLabel?: string | null;
    correlationId?: string | null;
  }): Promise<AgentRun> {
    return withTransaction(this.deps.pool, async (tx) => {
      const run = await this.deps.party.createRun(tx, {
        projectId: input.projectId,
        sessionId: input.sessionId,
        agentInstanceId: input.agentInstanceId,
        client: input.client,
        workspaceKey: input.workspaceKey ?? null,
        workspaceLabel: sanitizeWorkspaceLabel(input.workspaceLabel),
        leaseSeconds: this.deps.agentRunLeaseSeconds,
      });

      await this.deps.outbox.emit(tx, {
        aggregateType: 'agent_run',
        aggregateId: run.id,
        topic: 'party.agent_started',
        payload: { client: input.client, session_id: input.sessionId },
        correlationId: input.correlationId ?? null,
        projectId: input.projectId,
      });

      return run;
    });
  }

  async getRun(id: string): Promise<AgentRun> {
    const run = await this.deps.party.findRunById(this.deps.pool, id);
    if (run === null) {
      throw new SagaError('AGENT_RUN_NOT_FOUND', 'No agent run matches that id.', {
        details: { agent_run_id: id },
      });
    }
    return run;
  }

  /**
   * Renew the lease. Heartbeats are idempotent and deliberately write no system event —
   * one event per heartbeat would bury every meaningful signal.
   */
  async heartbeat(input: {
    agentRunId: string;
    state?: 'active' | 'waiting';
    workItemId?: string | null;
    renewClaims?: boolean;
  }): Promise<{ run: AgentRun; renewedClaims: number; overlaps: OverlapDto[] }> {
    const run = await this.deps.party.heartbeat(this.deps.pool, input.agentRunId, {
      state: input.state,
      workItemId: input.workItemId,
      leaseSeconds: this.deps.agentRunLeaseSeconds,
    });
    if (run === null) {
      const existing = await this.deps.party.findRunById(this.deps.pool, input.agentRunId);
      if (existing === null) {
        throw new SagaError('AGENT_RUN_NOT_FOUND', 'No agent run matches that id.');
      }
      throw new SagaError(
        'AGENT_RUN_EXPIRED',
        `This agent run is ${existing.state}. Start a new run before continuing.`,
        { details: { state: existing.state } },
      );
    }

    const renewedClaims =
      input.renewClaims === false
        ? 0
        : await this.deps.party.renewClaimsForRun(
            this.deps.pool,
            run.id,
            this.deps.claimLeaseSeconds,
          );

    const overlaps = await this.overlapsFor(run);
    return { run, renewedClaims, overlaps };
  }

  async attachQuest(sessionId: string, workItemId: string): Promise<void> {
    await this.deps.party.attachQuest(this.deps.pool, sessionId, workItemId);
  }

  /** A clean end releases every claim the run holds, in one transaction. */
  async endRun(input: {
    agentRunId: string;
    reason?: string;
    correlationId?: string | null;
  }): Promise<{ run: AgentRun | null; releasedClaims: number }> {
    return withTransaction(this.deps.pool, async (tx) => {
      const released = await this.deps.party.releaseClaimsForRun(
        tx,
        input.agentRunId,
        input.reason ?? 'The agent run ended.',
      );
      const run = await this.deps.party.endRun(tx, input.agentRunId, 'ended');
      if (run !== null) {
        await this.deps.outbox.emit(tx, {
          aggregateType: 'agent_run',
          aggregateId: run.id,
          topic: 'party.agent_ended',
          payload: { client: run.client, released_claims: released },
          correlationId: input.correlationId ?? null,
          projectId: run.projectId,
        });
      }
      return { run, releasedClaims: released };
    });
  }

  async endRunForSession(sessionId: string): Promise<{ releasedClaims: number }> {
    const run = await this.deps.party.findLiveRunForSession(this.deps.pool, sessionId);
    if (run === null) return { releasedClaims: 0 };
    const result = await this.endRun({ agentRunId: run.id });
    return { releasedClaims: result.releasedClaims };
  }

  /**
   * Expire agent runs whose lease lapsed, releasing their claims.
   *
   * The durable Quest session and every checkpoint are untouched: only live coordination
   * state expires (spec 10.1).
   */
  async reapExpiredRuns(limit = 100): Promise<{ expired: string[]; releasedClaims: number }> {
    return withTransaction(this.deps.pool, async (tx) => {
      const stale = await this.deps.party.findExpiredRuns(tx, limit);
      const expired: string[] = [];
      let releasedClaims = 0;

      for (const run of stale) {
        releasedClaims += await this.deps.party.releaseClaimsForRun(
          tx,
          run.id,
          'The agent run lease expired.',
        );
        await this.deps.party.endRun(tx, run.id, 'expired');
        await this.deps.outbox.emit(tx, {
          aggregateType: 'agent_run',
          aggregateId: run.id,
          topic: 'party.agent_expired',
          payload: {
            client: run.client,
            session_id: run.sessionId,
            last_heartbeat_at: run.heartbeatAt?.toISOString() ?? null,
          },
          projectId: run.projectId,
        });
        expired.push(run.id);
      }

      return { expired, releasedClaims };
    });
  }

  // --- claims --------------------------------------------------------------

  /**
   * Acquire a claim (spec 7.16). In one transaction:
   *   1. resolve or create the resource and lock its row
   *   2. expire stale claims for that resource
   *   3. inspect the still-active claims against the resource policy
   *   4. reject, or insert the new claim
   *   5. emit the outbox event
   *
   * Never a `check then insert` without the row lock.
   */
  async acquireClaim(input: {
    projectId: string;
    agentRunId: string;
    workItemId: string;
    resourceType: ResourceType;
    resourceKey: string;
    mode: ClaimMode;
    baseFingerprint?: string | null;
    leaseSeconds?: number;
    correlationId?: string | null;
  }): Promise<AcquireResult> {
    const run = await this.getRun(input.agentRunId);
    if (run.state === 'ended' || run.state === 'expired') {
      throw new SagaError(
        'AGENT_RUN_EXPIRED',
        `This agent run is ${run.state} and cannot hold claims.`,
      );
    }
    if (run.projectId !== input.projectId) {
      throw new SagaError('AGENT_RUN_NOT_FOUND', 'That agent run belongs to another project.');
    }

    return withTransaction(this.deps.pool, async (tx) => {
      // Re-checked under a row lock inside the transaction that grants the claim. The check
      // above runs against a snapshot, and `state` alone is not liveness: only the reaper
      // flips a crashed run to `expired`, so between the crash and the next sweep the row
      // still reads `active`. A run without a live lease must not gain new claims (spec 4.5).
      const locked = await this.deps.party.lockRun(tx, input.agentRunId);
      if (locked === null) {
        throw new SagaError('AGENT_RUN_NOT_FOUND', 'That agent run no longer exists.');
      }
      if (
        locked.state === 'ended' ||
        locked.state === 'expired' ||
        locked.leaseExpiresAt === null ||
        locked.leaseExpiresAt.getTime() <= Date.now()
      ) {
        throw new SagaError(
          'AGENT_RUN_EXPIRED',
          'This agent run no longer holds a live lease and cannot take claims. Send a heartbeat first.',
          { details: { state: locked.state, lease_expires_at: locked.leaseExpiresAt } },
        );
      }

      const resource = await this.deps.party.lockOrCreateResource(tx, {
        projectId: input.projectId,
        resourceType: input.resourceType,
        resourceKey: input.resourceKey,
        policy: defaultPolicyFor(input.resourceType),
      });

      await this.deps.party.expireStaleClaims(tx, resource.id);
      const active = await this.deps.party.listActiveClaimsForResource(tx, resource.id);

      const decision = decideClaim({
        policy: resource.policy,
        requestedMode: input.mode,
        partyMode: this.deps.mode,
        resourceType: input.resourceType,
        activeClaims: active.map((claim) => ({
          id: claim.id,
          mode: claim.mode,
          agentRunId: claim.agentRunId,
          workItemId: claim.workItemId,
        })),
        requestingAgentRunId: input.agentRunId,
      });

      if (decision.outcome === 'already_held') {
        const existing = active.find((claim) => claim.id === decision.claimId)!;
        await this.deps.party.renewClaim(
          tx,
          existing.id,
          input.leaseSeconds ?? this.deps.claimLeaseSeconds,
        );
        const refreshed = await this.deps.party.findClaimById(tx, existing.id);
        return { claim: refreshed ?? existing, warnings: decision.warnings, alreadyHeld: true };
      }

      if (decision.outcome === 'denied') {
        const owner = active.find((claim) => decision.conflictingClaimIds.includes(claim.id))!;
        // The conflict body carries only what the caller needs to coordinate — never the
        // other agent's task text or file contents.
        throw new SagaError('RESOURCE_CLAIM_CONFLICT', decision.reason, {
          details: {
            resource_type: input.resourceType,
            resource_key: input.resourceKey,
            owner_quest_id: owner.workItemId,
            owner_quest_title: owner.workItemTitle,
            owner_client: owner.client,
            lease_expires_at: owner.leaseExpiresAt.toISOString(),
          },
        });
      }

      const claim = await this.deps.party.insertClaim(tx, {
        resourceId: resource.id,
        agentRunId: input.agentRunId,
        workItemId: input.workItemId,
        mode: input.mode,
        baseFingerprint: input.baseFingerprint ?? null,
        leaseSeconds: input.leaseSeconds ?? this.deps.claimLeaseSeconds,
      });

      await this.deps.outbox.emit(tx, {
        aggregateType: 'claim',
        aggregateId: claim.id,
        topic: 'party.claim_acquired',
        payload: {
          resource_type: input.resourceType,
          resource_key: input.resourceKey,
          mode: input.mode,
          work_item_id: input.workItemId,
        },
        correlationId: input.correlationId ?? null,
        projectId: input.projectId,
      });

      return { claim, warnings: decision.warnings, alreadyHeld: false };
    });
  }

  async renewClaim(claimId: string, agentRunId: string): Promise<Claim> {
    const claim = await this.deps.party.findClaimById(this.deps.pool, claimId);
    if (claim === null) throw new SagaError('CLAIM_NOT_FOUND', 'No claim matches that id.');
    if (claim.agentRunId !== agentRunId) {
      throw new SagaError('CLAIM_NOT_OWNED', 'That claim belongs to another agent run.');
    }
    if (claim.state !== 'active') {
      throw new SagaError('CLAIM_STATE_INVALID', `A ${claim.state} claim cannot be renewed.`);
    }
    await this.deps.party.renewClaim(this.deps.pool, claimId, this.deps.claimLeaseSeconds);
    return (await this.deps.party.findClaimById(this.deps.pool, claimId))!;
  }

  /** Release is idempotent: releasing an already released claim is not an error. */
  async releaseClaim(input: {
    claimId: string;
    agentRunId: string;
    reason?: string;
    correlationId?: string | null;
  }): Promise<Claim> {
    return withTransaction(this.deps.pool, async (tx) => {
      const claim = await this.deps.party.lockClaimById(tx, input.claimId);
      if (claim === null) throw new SagaError('CLAIM_NOT_FOUND', 'No claim matches that id.');
      if (claim.agentRunId !== input.agentRunId) {
        throw new SagaError('CLAIM_NOT_OWNED', 'That claim belongs to another agent run.');
      }
      if (claim.state !== 'active') return claim;

      const released = await this.deps.party.releaseClaim(
        tx,
        input.claimId,
        'released',
        input.reason ?? null,
      );
      const run = await this.deps.party.findRunById(tx, claim.agentRunId);
      await this.deps.outbox.emit(tx, {
        aggregateType: 'claim',
        aggregateId: claim.id,
        topic: 'party.claim_released',
        payload: {
          resource_type: claim.resourceType,
          resource_key: claim.resourceKey,
          reason: input.reason ?? null,
        },
        correlationId: input.correlationId ?? null,
        projectId: run?.projectId ?? null,
      });
      return released ?? claim;
    });
  }

  /** Administrative revocation. The caller is responsible for confirmation and the audit log. */
  async revokeClaim(input: {
    claimId: string;
    reason: string;
    actorLabel: string;
    correlationId?: string | null;
  }): Promise<Claim> {
    return withTransaction(this.deps.pool, async (tx) => {
      const claim = await this.deps.party.lockClaimById(tx, input.claimId);
      if (claim === null) throw new SagaError('CLAIM_NOT_FOUND', 'No claim matches that id.');
      if (claim.state !== 'active') {
        throw new SagaError('CLAIM_STATE_INVALID', `A ${claim.state} claim cannot be revoked.`);
      }

      const revoked = await this.deps.party.releaseClaim(
        tx,
        input.claimId,
        'revoked',
        `${input.reason} (revoked by ${input.actorLabel})`,
      );
      const run = await this.deps.party.findRunById(tx, claim.agentRunId);
      await this.deps.outbox.emit(tx, {
        aggregateType: 'claim',
        aggregateId: claim.id,
        topic: 'party.claim_revoked',
        payload: {
          resource_type: claim.resourceType,
          resource_key: claim.resourceKey,
          reason: input.reason,
          actor: input.actorLabel,
        },
        correlationId: input.correlationId ?? null,
        projectId: run?.projectId ?? null,
      });
      return revoked ?? claim;
    });
  }

  // --- status and context --------------------------------------------------

  async status(projectId: string): Promise<{
    runs: AgentRun[];
    claims: Claim[];
    snapshots: AgentSnapshot[];
    overlaps: OverlapDto[];
  }> {
    const runs = await this.deps.party.listLiveRuns(this.deps.pool, projectId);
    const claims = await this.deps.party.listClaimsForProject(this.deps.pool, projectId, false);
    const snapshots = await this.snapshotsFor(runs, claims);

    const overlaps: OverlapDto[] = [];
    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      for (const overlap of detectOverlaps(snapshot, snapshots)) {
        // Every pair is examined twice; keep one direction.
        const key =
          [snapshot.agentRunId, overlap.other_agent_run_id].sort().join('|') + overlap.kind;
        if (seen.has(key)) continue;
        seen.add(key);
        overlaps.push(overlap);
      }
    }

    return { runs, claims, snapshots, overlaps };
  }

  /** The Party layer of agent context (spec 10.6). */
  async contextFor(input: {
    projectId: string;
    sessionId: string | null;
    workItemId: string | null;
  }): Promise<{ rendered: string; data: Record<string, unknown>; warnings: string[] }> {
    if (!this.enabled) {
      return { rendered: '', data: { mode: 'off' }, warnings: [] };
    }

    const { runs, claims, snapshots } = await this.status(input.projectId);
    const self = snapshots.find(
      (snapshot) =>
        (input.sessionId !== null && snapshot.sessionId === input.sessionId) ||
        (input.workItemId !== null && snapshot.workItemId === input.workItemId),
    );

    const peers = snapshots.filter((snapshot) => snapshot.agentRunId !== self?.agentRunId);
    const overlaps = self === undefined ? [] : detectOverlaps(self, peers);

    const rendered = renderPartyContext(
      peers,
      overlaps,
      claims
        .filter((claim) => claim.agentRunId !== self?.agentRunId)
        .map((claim) => ({
          resourceType: claim.resourceType,
          resourceKey: claim.resourceKey,
          mode: claim.mode,
          questTitle: claim.workItemTitle,
          leaseExpiresAt: claim.leaseExpiresAt,
        })),
    );

    const warnings = overlaps
      .filter((overlap) => overlap.severity === 'critical')
      .map((overlap) => overlap.message);

    return {
      rendered,
      data: {
        mode: this.deps.mode,
        active_agents: peers.map((peer) => ({
          client: peer.client,
          quest_title: peer.questTitle,
          workspace_label: runs.find((run) => run.id === peer.agentRunId)?.workspaceLabel ?? null,
        })),
        overlaps,
        claims: claims.map((claim) => ({
          resource_type: claim.resourceType,
          resource_key: claim.resourceKey,
          mode: claim.mode,
          owner_quest_title: claim.workItemTitle,
          lease_expires_at: claim.leaseExpiresAt.toISOString(),
        })),
      },
      warnings,
    };
  }

  // --- fingerprints --------------------------------------------------------

  async reportFingerprints(input: {
    projectId: string;
    agentRunId: string;
    workItemId: string;
    files: readonly { path: string; base_hash?: string; current_hash?: string }[];
  }): Promise<{ recorded: number; conflicts: FingerprintConflictDto[] }> {
    const recorded = await withTransaction(this.deps.pool, (tx) =>
      this.deps.party.recordFingerprints(tx, {
        projectId: input.projectId,
        workItemId: input.workItemId,
        agentRunId: input.agentRunId,
        files: input.files.map((file) => ({
          path: file.path,
          baseHash: file.base_hash,
          currentHash: file.current_hash,
        })),
      }),
    );

    const others = await this.deps.party.findConflictingFingerprints(this.deps.pool, {
      projectId: input.projectId,
      workItemId: input.workItemId,
      paths: input.files.map((file) => file.path),
    });

    const byPath = new Map(input.files.map((file) => [file.path, file]));
    const conflicts: FingerprintConflictDto[] = [];
    for (const other of others) {
      const mine = byPath.get(other.path);
      if (mine === undefined) continue;
      // Only a divergence matters: matching hashes mean both agents see the same file.
      if (
        mine.base_hash !== undefined &&
        other.currentHash !== null &&
        mine.base_hash !== other.currentHash
      ) {
        conflicts.push({
          path: other.path,
          your_base_hash: mine.base_hash,
          observed_hash: other.currentHash,
          other_quest_id: other.workItemId,
          other_quest_title: other.workItemTitle,
          message: `"${other.path}" was changed by "${other.workItemTitle}" since you read it. Re-read the file before writing.`,
        });
      }
    }

    return { recorded, conflicts };
  }

  // --- helpers -------------------------------------------------------------

  private async snapshotsFor(
    runs: readonly AgentRun[],
    claims: readonly Claim[],
  ): Promise<AgentSnapshot[]> {
    const workItemIds = runs.map((run) => run.workItemId).filter((id): id is string => id !== null);

    const quests = new Map<string, { title: string; scope: Record<string, string[]> }>();
    for (const id of new Set(workItemIds)) {
      const quest = await this.deps.quests.findById(this.deps.pool, id);
      if (quest !== null) {
        quests.set(id, { title: quest.title, scope: quest.scope as Record<string, string[]> });
      }
    }

    const changedFiles = await this.deps.party.listChangedFilesForRuns(this.deps.pool, [
      ...new Set(workItemIds),
    ]);

    return runs.map((run) => {
      const quest = run.workItemId === null ? undefined : quests.get(run.workItemId);
      return {
        agentRunId: run.id,
        sessionId: run.sessionId,
        client: run.client,
        workspaceKey: run.workspaceKey,
        workItemId: run.workItemId,
        questTitle: quest?.title ?? null,
        scope: quest?.scope ?? {},
        claims: claims
          .filter((claim) => claim.agentRunId === run.id)
          .map((claim) => ({
            resourceType: claim.resourceType,
            resourceKey: claim.resourceKey,
            mode: claim.mode,
          })),
        changedFiles: run.workItemId === null ? [] : (changedFiles.get(run.workItemId) ?? []),
      };
    });
  }

  private async overlapsFor(run: AgentRun): Promise<OverlapDto[]> {
    const { snapshots } = await this.status(run.projectId);
    const self = snapshots.find((snapshot) => snapshot.agentRunId === run.id);
    if (self === undefined) return [];
    return detectOverlaps(self, snapshots);
  }

  /** Guidance for a fail-closed operation when Party itself cannot be reached. */
  unavailableGuidance(resourceType: ResourceType): string {
    return coordinationUnavailableGuidance(resourceType);
  }

  isFailClosed(resourceType: ResourceType): boolean {
    return isFailClosed(resourceType);
  }

  async counts(): Promise<{ activeAgentRuns: number; activeClaims: number }> {
    const [activeAgentRuns, activeClaims] = await Promise.all([
      this.deps.party.countLive(this.deps.pool),
      this.deps.party.countActiveClaims(this.deps.pool),
    ]);
    return { activeAgentRuns, activeClaims };
  }
}
