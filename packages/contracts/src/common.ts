import { ERROR_CODES, MAX_PAGE_SIZE } from '@saga/shared';
import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const isoTimestampSchema = z.string().datetime({ offset: true });
export const nullableIsoTimestampSchema = isoTimestampSchema.nullable();

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.unknown()).default({}),
    request_id: z.string(),
  }),
});
export type ErrorEnvelopeDto = z.infer<typeof errorEnvelopeSchema>;

export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  });
}

/** `projectRef` accepts a UUID, the current name, its normalized form, or a former alias. */
export const projectRefSchema = z.string().min(1).max(300);

export const projectRefParamsSchema = z.object({ projectRef: projectRefSchema });

export const idempotencyHeaderSchema = z.object({
  'idempotency-key': z.string().min(8).max(200).optional(),
});

export const AGENT_SCOPES = [
  'project:read',
  'lore:read',
  'lore:propose',
  'lore:publish',
  'quest:read',
  'quest:write',
  'party:heartbeat',
  'party:claim',
] as const;
export const agentScopeSchema = z.enum(AGENT_SCOPES);
export type AgentScope = z.infer<typeof agentScopeSchema>;

export const USER_ROLES = ['admin', 'operator', 'viewer'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * Permissions the API checks. The role and scope matrices that map onto them live in
 * `@saga/core`; the names live here so Guild Hall can hide an action the caller cannot
 * perform without duplicating the server's matrix.
 */
export const PERMISSIONS = [
  'project:read',
  'project:write',
  'project:archive',
  'lore:read',
  'lore:propose',
  'lore:publish',
  'lore:archive',
  'quest:read',
  'quest:write',
  'party:read',
  'party:heartbeat',
  'party:claim',
  'party:revoke',
  'shrine:read',
  'shrine:operate',
  'security:manage',
] as const;
export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

/** Evidence is optional metadata. `vcs_revision` is never identity — see ADR-0001. */
export const evidenceItemSchema = z.object({
  path: z.string().min(1).max(1_000),
  content_hash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, 'content_hash must look like sha256:<64 hex chars>')
    .optional(),
  observed_at: isoTimestampSchema.optional(),
  vcs_revision: z.string().max(200).optional(),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const evidenceSchema = z.array(evidenceItemSchema).max(50);

export const okSchema = z.object({ ok: z.literal(true) });

/** Disruptive administrative actions must state why; the reason lands in `security.audit_logs`. */
export const reasonRequestSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required.').max(1_000),
});
export type ReasonRequest = z.infer<typeof reasonRequestSchema>;
