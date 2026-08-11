import type { AgentRunDto, ClaimDto } from '@saga/contracts';
import type { AgentRun, Claim } from '@saga/party';
import { toIso, toIsoRequired } from '@saga/shared';

export function presentAgentRun(run: AgentRun, now: Date): AgentRunDto {
  return {
    id: run.id,
    project_id: run.projectId,
    session_id: run.sessionId,
    work_item_id: run.workItemId,
    agent_instance_id: run.agentInstanceId,
    client: run.client,
    // `workspace_key` is a machine identity and is deliberately never presented.
    workspace_label: run.workspaceLabel,
    state: run.state,
    // Liveness comes from the lease, not from the stored state column.
    live:
      run.state !== 'ended' &&
      run.state !== 'expired' &&
      run.leaseExpiresAt !== null &&
      run.leaseExpiresAt.getTime() > now.getTime(),
    heartbeat_at: toIso(run.heartbeatAt),
    last_activity_at: toIso(run.lastActivityAt),
    last_activity: run.lastActivity,
    lease_expires_at: toIso(run.leaseExpiresAt),
    started_at: toIsoRequired(run.startedAt),
    ended_at: toIso(run.endedAt),
  };
}

export function presentClaim(claim: Claim): ClaimDto {
  return {
    id: claim.id,
    resource_type: claim.resourceType,
    resource_key: claim.resourceKey,
    resource_policy: claim.resourcePolicy,
    mode: claim.mode,
    state: claim.state,
    agent_run_id: claim.agentRunId,
    work_item_id: claim.workItemId,
    work_item_title: claim.workItemTitle,
    client: claim.client,
    base_fingerprint: claim.baseFingerprint,
    acquired_at: toIsoRequired(claim.acquiredAt),
    lease_expires_at: toIsoRequired(claim.leaseExpiresAt),
    released_at: toIso(claim.releasedAt),
    release_reason: claim.releaseReason,
  };
}
