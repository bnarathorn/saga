import { z } from 'zod';
import {
  agentScopeSchema,
  isoTimestampSchema,
  nullableIsoTimestampSchema,
  permissionSchema,
  userRoleSchema,
  uuidSchema,
} from './common.js';

export const loginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1_000),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const currentUserSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  display_name: z.string(),
  role: userRoleSchema,
  last_login_at: nullableIsoTimestampSchema,
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const loginResponseSchema = z.object({
  user: currentUserSchema,
  /** Double-submit CSRF token. Echo it in `X-Saga-CSRF` on every mutating request. */
  csrf_token: z.string(),
  expires_at: isoTimestampSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const meResponseSchema = z.object({
  authenticated: z.boolean(),
  actor_type: z.enum(['user', 'agent', 'anonymous']),
  user: currentUserSchema.nullable(),
  agent: z
    .object({
      token_id: uuidSchema,
      project_id: uuidSchema,
      name: z.string(),
      scopes: z.array(agentScopeSchema),
    })
    .nullable(),
  csrf_token: z.string().nullable(),
  /**
   * What this caller may do, resolved from their role or token scopes. Guild Hall hides
   * actions that are absent here; the API checks the same permissions independently, so a
   * hidden action is also a refused one.
   */
  permissions: z.array(permissionSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// --- device flow -----------------------------------------------------------

export const deviceStartRequestSchema = z.object({
  client: z.string().min(1).max(100),
  workspace_label: z.string().max(200).optional(),
  scopes: z.array(agentScopeSchema).min(1).max(16).optional(),
});
export type DeviceStartRequest = z.infer<typeof deviceStartRequestSchema>;

export const deviceStartResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  expires_at: isoTimestampSchema,
  interval_seconds: z.number().int().positive(),
});
export type DeviceStartResponse = z.infer<typeof deviceStartResponseSchema>;

export const deviceApproveRequestSchema = z.object({
  user_code: z.string().min(4).max(32),
  project_ref: z.string().min(1).max(300),
  token_name: z.string().min(1).max(120).optional(),
  scopes: z.array(agentScopeSchema).min(1).max(16).optional(),
  expires_in_days: z.number().int().min(1).max(3_650).optional(),
});
export type DeviceApproveRequest = z.infer<typeof deviceApproveRequestSchema>;

export const deviceStatusQuerySchema = z.object({ device_code: z.string().min(8).max(200) });

export const deviceStatusResponseSchema = z.object({
  state: z.enum(['pending', 'approved', 'consumed', 'denied', 'expired']),
  /** Returned exactly once, on the first poll after approval. Never stored in plaintext after. */
  token: z.string().nullable(),
  project: z.object({ id: uuidSchema, name: z.string() }).nullable(),
  scopes: z.array(agentScopeSchema).nullable(),
  expires_at: nullableIsoTimestampSchema,
});
export type DeviceStatusResponse = z.infer<typeof deviceStatusResponseSchema>;

export const devicePendingViewSchema = z.object({
  user_code: z.string(),
  client: z.string(),
  workspace_label: z.string().nullable(),
  requested_scopes: z.array(agentScopeSchema),
  expires_at: isoTimestampSchema,
});
export type DevicePendingView = z.infer<typeof devicePendingViewSchema>;

// --- agent tokens ----------------------------------------------------------

export const agentTokenSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  name: z.string(),
  token_prefix: z.string(),
  scopes: z.array(agentScopeSchema),
  client: z.string().nullable(),
  created_at: isoTimestampSchema,
  last_used_at: nullableIsoTimestampSchema,
  expires_at: nullableIsoTimestampSchema,
  revoked_at: nullableIsoTimestampSchema,
});
export type AgentTokenDto = z.infer<typeof agentTokenSchema>;

export const createAgentTokenRequestSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(agentScopeSchema).min(1).max(16),
  client: z.string().max(100).optional(),
  expires_in_days: z.number().int().min(1).max(3_650).optional(),
});
export type CreateAgentTokenRequest = z.infer<typeof createAgentTokenRequestSchema>;

export const createAgentTokenResponseSchema = z.object({
  token: agentTokenSchema,
  /** Shown once. Saga stores only a hash. */
  raw_token: z.string(),
});
export type CreateAgentTokenResponse = z.infer<typeof createAgentTokenResponseSchema>;
