import { z } from 'zod';
import {
  evidenceSchema,
  isoTimestampSchema,
  nullableIsoTimestampSchema,
  uuidSchema,
} from './common.js';
import {
  MEMORY_CATEGORIES,
  MEMORY_KINDS,
  MEMORY_RELATIONS,
  MEMORY_STATES,
  VERIFICATION_STATES,
  VOLATILITIES,
} from './constants.js';

export {
  MEMORY_CATEGORIES,
  MEMORY_KINDS,
  MEMORY_RELATIONS,
  MEMORY_STATES,
  VERIFICATION_STATES,
  VOLATILITIES,
};

export const memoryCategorySchema = z.enum(MEMORY_CATEGORIES);
export type MemoryCategory = z.infer<typeof memoryCategorySchema>;

export const memoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryStateSchema = z.enum(MEMORY_STATES);
export type MemoryState = z.infer<typeof memoryStateSchema>;

export const verificationStateSchema = z.enum(VERIFICATION_STATES);
export type VerificationState = z.infer<typeof verificationStateSchema>;

export const volatilitySchema = z.enum(VOLATILITIES);
export type Volatility = z.infer<typeof volatilitySchema>;

export const EMBEDDING_STATES = ['queued', 'claimed', 'ready', 'failed'] as const;
export const embeddingStateSchema = z.enum(EMBEDDING_STATES);

export const memoryRelationSchema = z.enum(MEMORY_RELATIONS);
export type MemoryRelation = z.infer<typeof memoryRelationSchema>;

export const MEMORY_UPDATE_STATES = [
  'draft',
  'validating',
  'ready',
  'published',
  'conflict',
  'failed',
  'cancelled',
] as const;
export const memoryUpdateStateSchema = z.enum(MEMORY_UPDATE_STATES);
export type MemoryUpdateState = z.infer<typeof memoryUpdateStateSchema>;

/** Lowercase dot-separated identifier, e.g. `run.api.local`. */
export const memoryKeySchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'A memory key must be lowercase, dot-separated.')
  .refine((key) => !key.includes('..') && !key.endsWith('.'), {
    message: 'A memory key cannot contain an empty segment or end with a dot.',
  });

export const MAX_BODY_CHARS = 20_000;

/** One proposed Lore Entry. */
export const loreEntryInputSchema = z.object({
  memory_key: memoryKeySchema,
  category: memoryCategorySchema,
  kind: memoryKindSchema,
  body: z.string().min(1).max(MAX_BODY_CHARS),
  data: z.record(z.unknown()).optional(),
  evidence: evidenceSchema.optional(),
  confidence: z.number().min(0).max(1),
  verification_state: verificationStateSchema,
  importance: z.number().int().min(0).max(100).optional(),
  volatility: volatilitySchema.optional(),
  /**
   * The version the proposer observed. Omit for a new entry; omitting it for an existing
   * entry means "I did not read the current value", which the service resolves to the
   * current pointer at proposal time — the publish comparison still catches a later change.
   */
  base_version_id: uuidSchema.nullable().optional(),
});
export type LoreEntryInput = z.infer<typeof loreEntryInputSchema>;

export const rememberRequestSchema = z.object({
  entries: z.array(loreEntryInputSchema).min(1).max(50),
  summary: z.string().min(1).max(500),
  session_id: uuidSchema.optional(),
});
export type RememberRequest = z.infer<typeof rememberRequestSchema>;

export const memoryVersionSchema = z.object({
  id: uuidSchema,
  memory_item_id: uuidSchema,
  base_version_id: uuidSchema.nullable(),
  body: z.string(),
  data: z.record(z.unknown()),
  evidence: z.array(z.record(z.unknown())),
  content_hash: z.string(),
  confidence: z.number(),
  verification_state: verificationStateSchema,
  embedding_state: embeddingStateSchema,
  embedding_model: z.string().nullable(),
  created_at: isoTimestampSchema,
  ready_at: nullableIsoTimestampSchema,
});
export type MemoryVersionDto = z.infer<typeof memoryVersionSchema>;

export const loreEntrySchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  memory_key: z.string(),
  category: memoryCategorySchema,
  kind: memoryKindSchema,
  state: memoryStateSchema,
  importance: z.number().int(),
  volatility: volatilitySchema,
  current_version: memoryVersionSchema.nullable(),
  last_verified_at: nullableIsoTimestampSchema,
  stale_reason: z.string().nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});
export type LoreEntryDto = z.infer<typeof loreEntrySchema>;

export const listLoreQuerySchema = z.object({
  category: memoryCategorySchema.optional(),
  kind: memoryKindSchema.optional(),
  state: memoryStateSchema.optional(),
  verification_state: verificationStateSchema.optional(),
  volatility: volatilitySchema.optional(),
  min_importance: z.coerce.number().int().min(0).max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListLoreQuery = z.infer<typeof listLoreQuerySchema>;

// --- search ----------------------------------------------------------------

export const loreSearchRequestSchema = z.object({
  query: z.string().min(1).max(2_000),
  limit: z.number().int().min(1).max(50).optional(),
  filters: z
    .object({
      categories: z.array(memoryCategorySchema).max(14).optional(),
      kinds: z.array(memoryKindSchema).max(7).optional(),
      states: z.array(memoryStateSchema).max(3).optional(),
      min_importance: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
  /** One hop by default; two is the hard maximum. */
  relation_depth: z.number().int().min(0).max(2).optional(),
});
export type LoreSearchRequest = z.infer<typeof loreSearchRequestSchema>;

export const loreSearchHitSchema = z.object({
  memory_key: z.string(),
  memory_item_id: uuidSchema,
  category: memoryCategorySchema,
  kind: memoryKindSchema,
  state: memoryStateSchema,
  importance: z.number().int(),
  verification_state: verificationStateSchema,
  volatility: volatilitySchema,
  body: z.string(),
  data: z.record(z.unknown()),
  evidence_summary: z.array(z.string()),
  last_verified_at: nullableIsoTimestampSchema,
  stale_reason: z.string().nullable(),
  score: z.number(),
  /** Which retrieval channels contributed, so a degraded search is visible to the caller. */
  matched_by: z.array(z.enum(['fulltext', 'trigram', 'vector', 'relation'])),
  via_relation: z
    .object({ from_memory_key: z.string(), relation: memoryRelationSchema })
    .nullable(),
});
export type LoreSearchHit = z.infer<typeof loreSearchHitSchema>;

export const loreSearchResponseSchema = z.object({
  hits: z.array(loreSearchHitSchema),
  /** `degraded` when the vector channel was unavailable and only text search ran. */
  mode: z.enum(['full', 'degraded']),
  warnings: z.array(z.string()),
  memory_revision: z.number().int(),
});
export type LoreSearchResponse = z.infer<typeof loreSearchResponseSchema>;

// --- updates ---------------------------------------------------------------

export const memoryUpdateItemSchema = z.object({
  memory_item_id: uuidSchema,
  memory_key: z.string(),
  base_version_id: uuidSchema.nullable(),
  candidate_version_id: uuidSchema,
  candidate: memoryVersionSchema,
  /** True when the current pointer has moved since this proposal was made. */
  conflicted: z.boolean(),
});
export type MemoryUpdateItemDto = z.infer<typeof memoryUpdateItemSchema>;

export const memoryUpdateSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  state: memoryUpdateStateSchema,
  summary: z.string(),
  error: z.string().nullable(),
  created_at: isoTimestampSchema,
  validating_at: nullableIsoTimestampSchema,
  ready_at: nullableIsoTimestampSchema,
  published_at: nullableIsoTimestampSchema,
  cancelled_at: nullableIsoTimestampSchema,
  items: z.array(memoryUpdateItemSchema),
  prepared_snapshot_id: uuidSchema.nullable(),
});
export type MemoryUpdateDto = z.infer<typeof memoryUpdateSchema>;

export const markStaleRequestSchema = z.object({
  reason: z.string().min(1).max(1_000),
});
export type MarkStaleRequest = z.infer<typeof markStaleRequestSchema>;

export const evidenceCheckRequestSchema = z.object({
  observations: z
    .array(
      z.object({
        path: z.string().min(1).max(1_000),
        /** Null means "this path no longer exists on disk". */
        content_hash: z.string().nullable(),
      }),
    )
    .min(1)
    .max(500),
});
export type EvidenceCheckRequest = z.infer<typeof evidenceCheckRequestSchema>;

export const evidenceCheckResponseSchema = z.object({
  checked: z.number().int(),
  drifted: z.array(
    z.object({
      memory_key: z.string(),
      path: z.string(),
      recorded_hash: z.string().nullable(),
      observed_hash: z.string().nullable(),
      reason: z.enum(['hash_changed', 'path_missing']),
    }),
  ),
  marked_stale: z.array(z.string()),
});
export type EvidenceCheckResponse = z.infer<typeof evidenceCheckResponseSchema>;

// --- links -----------------------------------------------------------------

export const createLinkRequestSchema = z.object({
  from_memory_key: memoryKeySchema,
  relation: memoryRelationSchema,
  to_memory_key: memoryKeySchema,
  metadata: z.record(z.unknown()).optional(),
});
export type CreateLinkRequest = z.infer<typeof createLinkRequestSchema>;

export const memoryLinkSchema = z.object({
  id: uuidSchema,
  from_memory_key: z.string(),
  relation: memoryRelationSchema,
  to_memory_key: z.string(),
  metadata: z.record(z.unknown()),
  created_at: isoTimestampSchema,
});
export type MemoryLinkDto = z.infer<typeof memoryLinkSchema>;

// --- context ---------------------------------------------------------------

export const CONTEXT_MODES = ['new_work', 'resume_work', 'inquiry'] as const;
export const contextModeSchema = z.enum(CONTEXT_MODES);
export type ContextMode = z.infer<typeof contextModeSchema>;

export const contextRequestSchema = z.object({
  task: z.string().max(4_000).optional(),
  mode: contextModeSchema.optional(),
  quest_id: uuidSchema.optional(),
  session_id: uuidSchema.optional(),
  token_budget: z.number().int().min(500).max(60_000).optional(),
});
export type ContextRequest = z.infer<typeof contextRequestSchema>;

export const contextSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  entries: z.array(
    z.object({
      memory_key: z.string(),
      body: z.string(),
      state: memoryStateSchema,
      verification_state: verificationStateSchema,
      stale_reason: z.string().nullable(),
    }),
  ),
});
export type ContextSectionDto = z.infer<typeof contextSectionSchema>;

export const contextResponseSchema = z.object({
  project: z.object({
    id: uuidSchema,
    name: z.string(),
    memory_revision: z.number().int(),
  }),
  mode: contextModeSchema.nullable(),
  core_context: z.string(),
  task_context: z.string().nullable(),
  continuation: z
    .object({
      summary: z.string(),
      checkpoint_id: uuidSchema,
      quest_revision: z.number().int(),
      recorded_at: isoTimestampSchema,
      recovered_from_interrupted_session: z.boolean(),
      next_steps: z.array(z.string()),
      blockers: z.array(z.record(z.unknown())),
      rendered: z.string(),
    })
    .nullable(),
  party: z.record(z.unknown()),
  warnings: z.array(z.string()),
  bootstrap_required: z.boolean(),
  token_counts: z.object({
    core: z.number().int(),
    task: z.number().int(),
    continuation: z.number().int(),
    party: z.number().int(),
  }),
});
export type ContextResponse = z.infer<typeof contextResponseSchema>;

export const contextSnapshotSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  project_revision: z.number().int(),
  state: z.enum(['building', 'ready', 'active', 'failed']),
  token_count: z.number().int(),
  rendered_context: z.string(),
  sections: z.array(contextSectionSchema),
  error: z.string().nullable(),
  created_at: isoTimestampSchema,
  ready_at: nullableIsoTimestampSchema,
  activated_at: nullableIsoTimestampSchema,
});
export type ContextSnapshotDto = z.infer<typeof contextSnapshotSchema>;

/** Bootstrap guidance returned when a project has no active context snapshot. */
export const bootstrapPlanSchema = z.object({
  required: z.boolean(),
  reason: z.string(),
  inspect_paths: z.array(z.string()),
  exclude_paths: z.array(z.string()),
  proposed_keys: z.array(
    z.object({
      memory_key: z.string(),
      category: memoryCategorySchema,
      kind: memoryKindSchema,
      guidance: z.string(),
    }),
  ),
  rules: z.array(z.string()),
});
export type BootstrapPlan = z.infer<typeof bootstrapPlanSchema>;
