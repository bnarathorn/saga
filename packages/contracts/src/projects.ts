import { z } from 'zod';
import { isoTimestampSchema, nullableIsoTimestampSchema, uuidSchema } from './common.js';

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);

export const LORE_APPROVAL_MODES = ['auto', 'manual'] as const;
export const loreApprovalModeSchema = z.enum(LORE_APPROVAL_MODES);

/**
 * Whether an agent may close its own Quest, or a person does it in Guild Hall.
 *
 * The same question `lore_approval_mode` answers for Lore, and deliberately the same two
 * values: `auto` honours what the agent declares at its final handoff, `manual` records the
 * declaration and leaves the Quest open. Neither mode ever *infers* completion — a Quest
 * closes because an agent said so, or because a person did.
 */
export const QUEST_COMPLETION_MODES = ['auto', 'manual'] as const;
export const questCompletionModeSchema = z.enum(QUEST_COMPLETION_MODES);

/**
 * A project is identified by its name alone. Repository URL, branch, commit and remote are
 * deliberately absent from the contract — see ADR-0001 and the greenfield boundary.
 */
export const projectNameSchema = z
  .string()
  .min(1, 'A project name is required.')
  .max(200, 'A project name may be at most 200 characters.');

export const projectSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  name_key: z.string(),
  description: z.string().nullable(),
  status: projectStatusSchema,
  memory_revision: z.number().int().nonnegative(),
  active_context_snapshot_id: uuidSchema.nullable(),
  lore_approval_mode: loreApprovalModeSchema,
  quest_completion_mode: questCompletionModeSchema,
  aliases: z.array(z.string()),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});
export type ProjectDto = z.infer<typeof projectSchema>;

/** Counters shown on the Projects page. Contributed by each domain, not read cross-schema. */
export const projectStatsSchema = z.object({
  lore_entry_count: z.number().int().nonnegative(),
  stale_lore_count: z.number().int().nonnegative(),
  open_quest_count: z.number().int().nonnegative(),
  blocked_quest_count: z.number().int().nonnegative(),
  active_agent_count: z.number().int().nonnegative(),
  failed_job_count: z.number().int().nonnegative(),
  last_activity_at: nullableIsoTimestampSchema,
});
export type ProjectStats = z.infer<typeof projectStatsSchema>;

export const projectSummarySchema = projectSchema.extend({
  stats: projectStatsSchema,
  bootstrap_required: z.boolean(),
});
export type ProjectSummaryDto = z.infer<typeof projectSummarySchema>;

export const createProjectRequestSchema = z.object({
  name: projectNameSchema,
  description: z.string().max(2_000).optional(),
  lore_approval_mode: loreApprovalModeSchema.optional(),
  quest_completion_mode: questCompletionModeSchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    name: projectNameSchema.optional(),
    description: z.string().max(2_000).nullable().optional(),
    lore_approval_mode: loreApprovalModeSchema.optional(),
    quest_completion_mode: questCompletionModeSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided.',
  });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const listProjectsQuerySchema = z.object({
  status: projectStatusSchema.optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

export const archiveProjectRequestSchema = z.object({
  reason: z.string().min(1).max(1_000),
});
export type ArchiveProjectRequest = z.infer<typeof archiveProjectRequestSchema>;
