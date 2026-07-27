import { z } from 'zod';
import { isoTimestampSchema, nullableIsoTimestampSchema, uuidSchema } from './common.js';
import { questScopeSchema } from './quest.js';

export const PARTY_MODES = ['off', 'advisory', 'strict'] as const;
export const partyModeSchema = z.enum(PARTY_MODES);
export type PartyMode = z.infer<typeof partyModeSchema>;

export const AGENT_RUN_STATES = [
  'starting',
  'active',
  'waiting',
  'ending',
  'ended',
  'expired',
] as const;
export const agentRunStateSchema = z.enum(AGENT_RUN_STATES);
export type AgentRunState = z.infer<typeof agentRunStateSchema>;

export const RESOURCE_TYPES = [
  'module',
  'file',
  'database_schema',
  'migration_sequence',
  'environment',
  'service',
  'deployment',
  'test_environment',
  'service_restart',
  'production_config',
] as const;
export const resourceTypeSchema = z.enum(RESOURCE_TYPES);
export type ResourceType = z.infer<typeof resourceTypeSchema>;

export const RESOURCE_POLICIES = ['shared', 'advisory', 'exclusive'] as const;
export const resourcePolicySchema = z.enum(RESOURCE_POLICIES);
export type ResourcePolicy = z.infer<typeof resourcePolicySchema>;

export const CLAIM_MODES = ['shared', 'exclusive'] as const;
export const claimModeSchema = z.enum(CLAIM_MODES);
export type ClaimMode = z.infer<typeof claimModeSchema>;

export const CLAIM_STATES = ['active', 'released', 'expired', 'revoked'] as const;
export const claimStateSchema = z.enum(CLAIM_STATES);
export type ClaimState = z.infer<typeof claimStateSchema>;

export const agentRunSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  session_id: uuidSchema,
  work_item_id: uuidSchema.nullable(),
  agent_instance_id: z.string(),
  client: z.string(),
  /** Sanitised label such as `machine-a:erp-main`. Absolute paths are never exposed. */
  workspace_label: z.string().nullable(),
  state: agentRunStateSchema,
  /** Derived from `lease_expires_at > now()`, not from `state` alone. */
  live: z.boolean(),
  heartbeat_at: nullableIsoTimestampSchema,
  lease_expires_at: nullableIsoTimestampSchema,
  started_at: isoTimestampSchema,
  ended_at: nullableIsoTimestampSchema,
});
export type AgentRunDto = z.infer<typeof agentRunSchema>;

export const startAgentRunRequestSchema = z.object({
  session_id: uuidSchema,
  agent_instance_id: z.string().min(1).max(200),
  client: z.string().min(1).max(100),
  workspace_key: z.string().max(200).optional(),
  workspace_label: z.string().max(200).optional(),
});
export type StartAgentRunRequest = z.infer<typeof startAgentRunRequestSchema>;

export const heartbeatRequestSchema = z.object({
  state: z.enum(['active', 'waiting']).optional(),
  work_item_id: uuidSchema.nullable().optional(),
  /** Renews eligible claims alongside the run lease. */
  renew_claims: z.boolean().optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const heartbeatResponseSchema = z.object({
  agent_run: agentRunSchema,
  renewed_claims: z.number().int(),
  /** Changes since the last heartbeat that the agent should react to. */
  overlaps: z.array(z.record(z.unknown())),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const claimSchema = z.object({
  id: uuidSchema,
  resource_type: resourceTypeSchema,
  resource_key: z.string(),
  resource_policy: resourcePolicySchema,
  mode: claimModeSchema,
  state: claimStateSchema,
  agent_run_id: uuidSchema,
  work_item_id: uuidSchema,
  work_item_title: z.string(),
  client: z.string(),
  base_fingerprint: z.string().nullable(),
  acquired_at: isoTimestampSchema,
  lease_expires_at: isoTimestampSchema,
  released_at: nullableIsoTimestampSchema,
  release_reason: z.string().nullable(),
});
export type ClaimDto = z.infer<typeof claimSchema>;

export const acquireClaimRequestSchema = z.object({
  agent_run_id: uuidSchema,
  work_item_id: uuidSchema,
  resource_type: resourceTypeSchema,
  resource_key: z.string().min(1).max(1_000),
  mode: claimModeSchema,
  base_fingerprint: z.string().max(200).nullable().optional(),
  lease_seconds: z.number().int().min(10).max(3_600).optional(),
});
export type AcquireClaimRequest = z.infer<typeof acquireClaimRequestSchema>;

export const releaseClaimRequestSchema = z.object({
  reason: z.string().max(1_000).optional(),
});
export type ReleaseClaimRequest = z.infer<typeof releaseClaimRequestSchema>;

export const revokeClaimRequestSchema = z.object({
  reason: z.string().min(1).max(1_000),
  /** An operator must confirm before an active critical claim is taken away. */
  confirm: z.literal(true),
});
export type RevokeClaimRequest = z.infer<typeof revokeClaimRequestSchema>;

export const OVERLAP_KINDS = [
  'workspace',
  'module',
  'file',
  'component',
  'api',
  'database',
  'claim',
] as const;
export const overlapKindSchema = z.enum(OVERLAP_KINDS);
export type OverlapKind = z.infer<typeof overlapKindSchema>;

export const OVERLAP_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const overlapSeveritySchema = z.enum(OVERLAP_SEVERITIES);

export const overlapSchema = z.object({
  kind: overlapKindSchema,
  severity: overlapSeveritySchema,
  message: z.string(),
  values: z.array(z.string()),
  other_agent_run_id: uuidSchema,
  other_client: z.string(),
  other_quest_id: uuidSchema.nullable(),
  other_quest_title: z.string().nullable(),
  same_workspace: z.boolean(),
});
export type OverlapDto = z.infer<typeof overlapSchema>;

export const partyStatusSchema = z.object({
  mode: partyModeSchema,
  project_id: uuidSchema,
  active_agents: z.array(
    agentRunSchema.extend({
      quest_title: z.string().nullable(),
      scope: questScopeSchema,
      claims: z.array(claimSchema),
    }),
  ),
  claims: z.array(claimSchema),
  overlaps: z.array(overlapSchema),
});
export type PartyStatusDto = z.infer<typeof partyStatusSchema>;

export const reportFingerprintsRequestSchema = z.object({
  agent_run_id: uuidSchema,
  work_item_id: uuidSchema,
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1_000),
        base_hash: z.string().max(200).optional(),
        current_hash: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type ReportFingerprintsRequest = z.infer<typeof reportFingerprintsRequestSchema>;

export const fingerprintConflictSchema = z.object({
  path: z.string(),
  your_base_hash: z.string().nullable(),
  observed_hash: z.string().nullable(),
  other_quest_id: uuidSchema,
  other_quest_title: z.string(),
  message: z.string(),
});
export type FingerprintConflictDto = z.infer<typeof fingerprintConflictSchema>;

export const reportFingerprintsResponseSchema = z.object({
  recorded: z.number().int(),
  conflicts: z.array(fingerprintConflictSchema),
});
export type ReportFingerprintsResponse = z.infer<typeof reportFingerprintsResponseSchema>;
