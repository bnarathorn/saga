import { z } from 'zod';
import { isoTimestampSchema, nullableIsoTimestampSchema, uuidSchema } from './common.js';

export const HEALTH_STATES = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const;
export const healthStateSchema = z.enum(HEALTH_STATES);
export type HealthState = z.infer<typeof healthStateSchema>;

export const healthCheckSchema = z.object({
  name: z.string(),
  status: healthStateSchema,
  message: z.string(),
  detail: z.record(z.unknown()).default({}),
  /** How long the check took. Useful for spotting a slow but reachable database. */
  duration_ms: z.number().nonnegative(),
});
export type HealthCheckDto = z.infer<typeof healthCheckSchema>;

export const shrineHealthSchema = z.object({
  status: healthStateSchema,
  version: z.string(),
  checked_at: isoTimestampSchema,
  checks: z.array(healthCheckSchema),
});
export type ShrineHealthDto = z.infer<typeof shrineHealthSchema>;

export const livenessSchema = z.object({ status: z.literal('ok'), uptime_seconds: z.number() });

export const readinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.array(healthCheckSchema),
});

export const SERVICE_ROLES = ['api', 'worker', 'scheduler'] as const;
export const serviceRoleSchema = z.enum(SERVICE_ROLES);

export const serviceInstanceSchema = z.object({
  id: uuidSchema,
  role: serviceRoleSchema,
  instance_key: z.string(),
  version: z.string(),
  hostname: z.string().nullable(),
  process_id: z.number().int().nullable(),
  state: z.enum(['starting', 'running', 'draining', 'stopped']),
  /** Derived from `lease_expires_at > now()`, not from `state`. */
  live: z.boolean(),
  started_at: isoTimestampSchema,
  heartbeat_at: isoTimestampSchema,
  lease_expires_at: isoTimestampSchema,
  heartbeat_age_seconds: z.number(),
  metadata: z.record(z.unknown()),
});
export type ServiceInstanceDto = z.infer<typeof serviceInstanceSchema>;

export const JOB_TYPES = [
  'noop',
  'embedding',
  'context_snapshot',
  'memory_validation',
  'stale_detection',
  'cleanup',
  'outbox_delivery',
  'event_projection',
  'session_reaper',
  'party_reaper',
  'retention_cleanup',
] as const;
export const jobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof jobTypeSchema>;

export const JOB_STATES = [
  'queued',
  'claimed',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const jobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof jobStateSchema>;

export const jobSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema.nullable(),
  job_type: jobTypeSchema,
  entity_type: z.string().nullable(),
  entity_id: uuidSchema.nullable(),
  dedupe_key: z.string().nullable(),
  state: jobStateSchema,
  priority: z.number().int(),
  /** Summarised, never the raw payload: job payloads may reference local paths. */
  payload_summary: z.record(z.unknown()),
  result_summary: z.record(z.unknown()).nullable(),
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  run_after: isoTimestampSchema,
  claimed_by: uuidSchema.nullable(),
  claimed_at: nullableIsoTimestampSchema,
  lease_expires_at: nullableIsoTimestampSchema,
  last_error: z.string().nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  completed_at: nullableIsoTimestampSchema,
});
export type JobDto = z.infer<typeof jobSchema>;

export const listJobsQuerySchema = z.object({
  state: jobStateSchema.optional(),
  job_type: jobTypeSchema.optional(),
  project_id: uuidSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const jobActionRequestSchema = z.object({
  reason: z.string().min(1).max(1_000),
});
export type JobActionRequest = z.infer<typeof jobActionRequestSchema>;

/**
 * Operators may enqueue a `noop` probe to prove the queue drains end to end. Deliberately
 * limited to that one job type: Shrine is not an arbitrary job-payload editor.
 */
export const enqueueProbeRequestSchema = z.object({
  echo: z.string().max(500).optional(),
  sleep_ms: z.number().int().min(0).max(60_000).optional(),
  fail: z.enum(['retryable', 'permanent']).optional(),
  project_id: uuidSchema.optional(),
});
export type EnqueueProbeRequest = z.infer<typeof enqueueProbeRequestSchema>;

export const SYSTEM_EVENT_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export const systemEventSeveritySchema = z.enum(SYSTEM_EVENT_SEVERITIES);

export const systemEventSchema = z.object({
  id: uuidSchema,
  sequence: z.number().int().positive(),
  severity: systemEventSeveritySchema,
  category: z.string(),
  project_id: uuidSchema.nullable(),
  entity_type: z.string().nullable(),
  entity_id: uuidSchema.nullable(),
  event_type: z.string(),
  message: z.string(),
  metadata: z.record(z.unknown()),
  created_at: isoTimestampSchema,
});
export type SystemEventDto = z.infer<typeof systemEventSchema>;

export const listEventsQuerySchema = z.object({
  severity: systemEventSeveritySchema.optional(),
  category: z.string().max(100).optional(),
  project_id: uuidSchema.optional(),
  since_sequence: z.coerce.number().int().nonnegative().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

/** Sanitized operational configuration. Never contains credentials or full DSNs. */
export const shrineConfigSchema = z.object({
  version: z.string(),
  node_env: z.string(),
  started_at: isoTimestampSchema,
  database: z.object({ host: z.string(), database: z.string(), pool_max: z.number().int() }),
  tls_enabled: z.boolean(),
  embedding: z.object({
    provider: z.string(),
    model: z.string(),
    dimensions: z.number().int(),
  }),
  worker: z.object({
    concurrency: z.number().int(),
    job_lease_seconds: z.number().int(),
    job_max_attempts: z.number().int(),
  }),
  retention: z.object({
    job_days: z.number().int(),
    system_event_days: z.number().int(),
    idempotency_hours: z.number().int(),
  }),
  context_budgets: z.object({
    core: z.number().int(),
    task: z.number().int(),
    continuation: z.number().int(),
    party: z.number().int(),
  }),
  party_mode: z.enum(['off', 'advisory', 'strict']),
  dev_auth_bypass: z.boolean(),
});
export type ShrineConfigDto = z.infer<typeof shrineConfigSchema>;

export const schemaVersionSchema = z.object({
  current_version: z.number().int().nonnegative(),
  expected_version: z.number().int().nonnegative(),
  up_to_date: z.boolean(),
  applied: z.array(
    z.object({ version: z.number().int(), name: z.string(), applied_at: isoTimestampSchema }),
  ),
  pending: z.array(z.object({ version: z.number().int(), name: z.string() })),
});
export type SchemaVersionDto = z.infer<typeof schemaVersionSchema>;

export const metricsSummarySchema = z.object({
  collected_at: isoTimestampSchema,
  projects: z.object({ total: z.number().int(), active: z.number().int() }),
  jobs: z.object({
    queued: z.number().int(),
    claimed: z.number().int(),
    retrying: z.number().int(),
    failed: z.number().int(),
    succeeded_last_hour: z.number().int(),
    oldest_queued_age_seconds: z.number().nullable(),
  }),
  outbox: z.object({ pending: z.number().int(), failed: z.number().int() }),
  services: z.object({ api_live: z.number().int(), worker_live: z.number().int() }),
  party: z.object({ active_agent_runs: z.number().int(), active_claims: z.number().int() }),
  lore: z.object({ entries: z.number().int(), stale: z.number().int() }),
  quest: z.object({ open: z.number().int(), blocked: z.number().int() }),
  sse: z.object({ clients: z.number().int() }),
});
export type MetricsSummaryDto = z.infer<typeof metricsSummarySchema>;

export const auditLogSchema = z.object({
  id: uuidSchema,
  actor_type: z.enum(['user', 'agent', 'system']),
  actor_id: uuidSchema.nullable(),
  actor_label: z.string().nullable(),
  action: z.string(),
  project_id: uuidSchema.nullable(),
  entity_type: z.string().nullable(),
  entity_id: uuidSchema.nullable(),
  reason: z.string().nullable(),
  request_id: z.string().nullable(),
  metadata: z.record(z.unknown()),
  created_at: isoTimestampSchema,
});
export type AuditLogDto = z.infer<typeof auditLogSchema>;
