import type {
  AgentTokenDto,
  AuditLogDto,
  JobDto,
  ProjectDto,
  ServiceInstanceDto,
  SystemEventDto,
} from '@saga/contracts';
import type { AgentTokenRecord, ProjectWithAliases } from '@saga/core';
import type { AuditEntry, Job, ServiceInstance, SystemEvent } from '@saga/shrine';
import { toIso, toIsoRequired } from '@saga/shared';

export function presentProject(project: ProjectWithAliases): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    name_key: project.nameKey,
    description: project.description,
    status: project.status,
    memory_revision: project.memoryRevision,
    active_context_snapshot_id: project.activeContextSnapshotId,
    lore_approval_mode: project.loreApprovalMode,
    quest_completion_mode: project.questCompletionMode,
    aliases: project.aliases,
    created_at: toIsoRequired(project.createdAt),
    updated_at: toIsoRequired(project.updatedAt),
  };
}

/**
 * Job payloads may reference local file paths and task text, so Shrine shows a summary rather
 * than the raw document: primitive fields pass through, everything else becomes a shape hint.
 */
export function summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || ['number', 'boolean'].includes(typeof value)) {
      summary[key] = value;
    } else if (typeof value === 'string') {
      summary[key] = value.length <= 120 ? value : `${value.slice(0, 117)}…`;
    } else if (Array.isArray(value)) {
      summary[key] = `array(${value.length})`;
    } else {
      summary[key] = `object(${Object.keys(value as object).length} keys)`;
    }
  }
  return summary;
}

export function presentJob(job: Job): JobDto {
  return {
    id: job.id,
    project_id: job.projectId,
    job_type: job.jobType,
    entity_type: job.entityType,
    entity_id: job.entityId,
    dedupe_key: job.dedupeKey,
    state: job.state,
    priority: job.priority,
    payload_summary: summarizePayload(job.payload),
    result_summary: job.result === null ? null : summarizePayload(job.result),
    attempts: job.attempts,
    max_attempts: job.maxAttempts,
    run_after: toIsoRequired(job.runAfter),
    claimed_by: job.claimedBy,
    claimed_at: toIso(job.claimedAt),
    lease_expires_at: toIso(job.leaseExpiresAt),
    last_error: job.lastError,
    created_at: toIsoRequired(job.createdAt),
    updated_at: toIsoRequired(job.updatedAt),
    completed_at: toIso(job.completedAt),
  };
}

export function presentServiceInstance(instance: ServiceInstance, now: Date): ServiceInstanceDto {
  return {
    id: instance.id,
    role: instance.role,
    instance_key: instance.instanceKey,
    version: instance.version,
    hostname: instance.hostname,
    process_id: instance.processId,
    state: instance.state,
    // Liveness comes from the lease, never from the stored state column.
    live: instance.leaseExpiresAt.getTime() > now.getTime(),
    started_at: toIsoRequired(instance.startedAt),
    heartbeat_at: toIsoRequired(instance.heartbeatAt),
    lease_expires_at: toIsoRequired(instance.leaseExpiresAt),
    heartbeat_age_seconds: Math.max(
      0,
      Math.round((now.getTime() - instance.heartbeatAt.getTime()) / 1000),
    ),
    metadata: instance.metadata,
  };
}

export function presentSystemEvent(event: SystemEvent): SystemEventDto {
  return {
    id: event.id,
    sequence: event.sequence,
    severity: event.severity,
    category: event.category,
    project_id: event.projectId,
    entity_type: event.entityType,
    entity_id: event.entityId,
    event_type: event.eventType,
    message: event.message,
    metadata: event.metadata,
    created_at: toIsoRequired(event.createdAt),
  };
}

export function presentAgentToken(token: AgentTokenRecord): AgentTokenDto {
  return {
    id: token.id,
    project_id: token.projectId,
    name: token.name,
    token_prefix: token.tokenPrefix,
    scopes: token.scopes,
    client: token.client,
    created_at: toIsoRequired(token.createdAt),
    last_used_at: toIso(token.lastUsedAt),
    expires_at: toIso(token.expiresAt),
    revoked_at: toIso(token.revokedAt),
  };
}

export function presentAuditEntry(entry: AuditEntry): AuditLogDto {
  return {
    id: entry.id,
    actor_type: entry.actorType,
    actor_id: entry.actorId,
    actor_label: entry.actorLabel,
    action: entry.action,
    project_id: entry.projectId,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    reason: entry.reason,
    request_id: entry.requestId,
    metadata: entry.metadata,
    created_at: toIsoRequired(entry.createdAt),
  };
}
