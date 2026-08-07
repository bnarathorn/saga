import { z } from 'zod';
import { contextModeSchema } from './lore.js';
import { isoTimestampSchema, nullableIsoTimestampSchema, uuidSchema } from './common.js';

export const QUEST_STATUSES = [
  'open',
  'in_progress',
  'waiting',
  'blocked',
  'completed',
  'cancelled',
] as const;
export const questStatusSchema = z.enum(QUEST_STATUSES);
export type QuestStatus = z.infer<typeof questStatusSchema>;

export const QUEST_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export const questPrioritySchema = z.enum(QUEST_PRIORITIES);
export type QuestPriority = z.infer<typeof questPrioritySchema>;

export const DEPENDENCY_TYPES = ['blocks', 'requires_output', 'must_complete_before'] as const;
export const dependencyTypeSchema = z.enum(DEPENDENCY_TYPES);
export type DependencyType = z.infer<typeof dependencyTypeSchema>;

export const CHECKPOINT_KINDS = ['automatic', 'milestone', 'final_handoff'] as const;
export const checkpointKindSchema = z.enum(CHECKPOINT_KINDS);
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;

export const QUEST_STEP_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const;
export const questStepStatusSchema = z.enum(QUEST_STEP_STATUSES);
export type QuestStepStatus = z.infer<typeof questStepStatusSchema>;

export const SESSION_STATES = ['awaiting_task', 'active', 'completed', 'abandoned'] as const;
export const sessionStateSchema = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const ACTIVATION_MODES = ['new_work', 'resume_work', 'inquiry'] as const;
export const activationModeSchema = z.enum(ACTIVATION_MODES);
export type ActivationMode = z.infer<typeof activationModeSchema>;

/**
 * Declared scope. Every field is optional: an agent records what it knows, and Party uses
 * whatever is present to detect overlap. No field is a version-control coordinate.
 */
export const questScopeSchema = z.object({
  modules: z.array(z.string().max(500)).max(100).optional(),
  components: z.array(z.string().max(200)).max(100).optional(),
  apis: z.array(z.string().max(300)).max(100).optional(),
  databases: z.array(z.string().max(200)).max(50).optional(),
  files: z.array(z.string().max(1_000)).max(500).optional(),
  issue_keys: z.array(z.string().max(100)).max(50).optional(),
});
export type QuestScope = z.infer<typeof questScopeSchema>;

export const questSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  parent_work_item_id: uuidSchema.nullable(),
  title: z.string(),
  objective: z.string().nullable(),
  status: questStatusSchema,
  priority: questPrioritySchema,
  scope: questScopeSchema,
  revision: z.number().int().nonnegative(),
  latest_checkpoint_id: uuidSchema.nullable(),
  created_at: isoTimestampSchema,
  last_activity_at: isoTimestampSchema,
  completed_at: nullableIsoTimestampSchema,
  archived_at: nullableIsoTimestampSchema,
});
export type QuestDto = z.infer<typeof questSchema>;

export const createQuestRequestSchema = z.object({
  title: z.string().min(1).max(300),
  objective: z.string().max(5_000).optional(),
  priority: questPrioritySchema.optional(),
  scope: questScopeSchema.optional(),
  parent_work_item_id: uuidSchema.nullable().optional(),
  session_id: uuidSchema.optional(),
});
export type CreateQuestRequest = z.infer<typeof createQuestRequestSchema>;

export const updateQuestRequestSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    objective: z.string().max(5_000).nullable().optional(),
    status: questStatusSchema.optional(),
    priority: questPrioritySchema.optional(),
    scope: questScopeSchema.optional(),
    parent_work_item_id: uuidSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided.',
  });
export type UpdateQuestRequest = z.infer<typeof updateQuestRequestSchema>;

export const listQuestsQuerySchema = z.object({
  status: questStatusSchema.optional(),
  priority: questPrioritySchema.optional(),
  parent_work_item_id: uuidSchema.optional(),
  include_archived: z.coerce.boolean().optional(),
  q: z.string().max(300).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ListQuestsQuery = z.infer<typeof listQuestsQuerySchema>;

export const createDependencyRequestSchema = z.object({
  depends_on_work_item_id: uuidSchema,
  dependency_type: dependencyTypeSchema,
});
export type CreateDependencyRequest = z.infer<typeof createDependencyRequestSchema>;

export const questDependencySchema = z.object({
  work_item_id: uuidSchema,
  depends_on_work_item_id: uuidSchema,
  depends_on_title: z.string(),
  depends_on_status: questStatusSchema,
  dependency_type: dependencyTypeSchema,
  created_at: isoTimestampSchema,
});
export type QuestDependencyDto = z.infer<typeof questDependencySchema>;

// --- plan ------------------------------------------------------------------

/**
 * One numbered sub-task of a Quest.
 *
 * A step is declared once and settled once. That is what separates it from the free-text
 * `completed` / `next_steps` arrays in a work state, which are rewritten wholesale on every
 * checkpoint and address nothing: a step has a stable number an agent can tick off, so the
 * server can answer "is this Quest finished?" without inferring anything (ADR-0011).
 */
export const questStepSchema = z.object({
  id: uuidSchema,
  work_item_id: uuidSchema,
  ordinal: z.number().int().positive(),
  title: z.string(),
  status: questStepStatusSchema,
  completed_at: nullableIsoTimestampSchema,
  completed_by_session_id: uuidSchema.nullable(),
  completed_by_checkpoint_id: uuidSchema.nullable(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
});
export type QuestStepDto = z.infer<typeof questStepSchema>;

/** How far through its plan a Quest is. Derived, never stored. */
export const planProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  /** True when every step is settled and at least one was actually done. */
  all_settled: z.boolean(),
  /** The lowest-numbered step still unsettled, or null when the plan is finished. */
  next_ordinal: z.number().int().positive().nullable(),
});
export type PlanProgressDto = z.infer<typeof planProgressSchema>;

export const questPlanSchema = z.object({
  steps: z.array(questStepSchema),
  progress: planProgressSchema,
});
export type QuestPlanDto = z.infer<typeof questPlanSchema>;

/**
 * Declare or re-declare a plan. Steps are numbered by their position, from 1.
 *
 * Re-declaring is allowed mid-Quest, so an agent that discovers more work can append to its
 * plan. A step keeps its recorded status when its position and title both survive the
 * re-declaration; anything renamed, inserted or reordered is a different step and starts
 * `pending`. Sending an empty array removes the plan and returns the Quest to declaration-only
 * completion.
 */
export const setQuestPlanRequestSchema = z.object({
  steps: z.array(z.string().min(1).max(500)).max(50),
});
export type SetQuestPlanRequest = z.infer<typeof setQuestPlanRequestSchema>;

/** Settle one step by its number. Omitting `status` means the step is done. */
export const stepUpdateSchema = z.object({
  ordinal: z.number().int().positive(),
  status: questStepStatusSchema.optional(),
});
export type StepUpdate = z.infer<typeof stepUpdateSchema>;

// --- work state ------------------------------------------------------------

export const blockerSchema = z.object({
  description: z.string().min(1).max(2_000),
  suggested_action: z.string().max(2_000).optional(),
});

export const decisionSchema = z.object({
  decision: z.string().min(1).max(2_000),
  reason: z.string().max(2_000).optional(),
});

/** File fingerprints let coordination work without any version-control system. */
export const changedFileSchema = z.object({
  path: z.string().min(1).max(1_000),
  base_hash: z.string().max(200).optional(),
  current_hash: z.string().max(200).optional(),
});

export const commandRecordSchema = z.object({
  command: z.string().min(1).max(2_000),
  status: z.enum(['succeeded', 'failed', 'skipped', 'running']).optional(),
  summary: z.string().max(2_000).optional(),
});

export const testRecordSchema = z.object({
  name: z.string().min(1).max(500),
  status: z.enum(['passed', 'failed', 'blocked', 'skipped', 'running']),
  summary: z.string().max(2_000).optional(),
});

export const workStateSchema = z.object({
  goal: z.string().min(1).max(2_000),
  completed: z.array(z.string().max(2_000)).max(200).default([]),
  in_progress: z.array(z.string().max(2_000)).max(200).default([]),
  next_steps: z.array(z.string().max(2_000)).max(200).default([]),
  blockers: z.array(blockerSchema).max(100).default([]),
  decisions: z.array(decisionSchema).max(100).default([]),
  changed_files: z.array(changedFileSchema).max(1_000).default([]),
  commands: z.array(commandRecordSchema).max(200).default([]),
  tests: z.array(testRecordSchema).max(200).default([]),
});
export type WorkState = z.infer<typeof workStateSchema>;

export const checkpointSchema = z.object({
  id: uuidSchema,
  session_id: uuidSchema,
  work_item_id: uuidSchema,
  base_work_item_revision: z.number().int(),
  sequence: z.number().int(),
  kind: checkpointKindSchema,
  summary: z.string(),
  work_state: workStateSchema,
  created_at: isoTimestampSchema,
});
export type CheckpointDto = z.infer<typeof checkpointSchema>;

export const createCheckpointRequestSchema = z.object({
  /** Compare-and-swap: the Quest revision the caller believes is current. */
  expected_quest_revision: z.number().int().nonnegative(),
  kind: checkpointKindSchema,
  summary: z.string().min(1).max(2_000),
  work_state: workStateSchema,
  /**
   * Plan steps settled by this checkpoint. Applied in the same transaction as the checkpoint,
   * so a step is never recorded as done without the checkpoint that says why.
   */
  step_updates: z.array(stepUpdateSchema).max(50).default([]),
});
export type CreateCheckpointRequest = z.infer<typeof createCheckpointRequestSchema>;

export const createCheckpointResponseSchema = z.object({
  checkpoint: checkpointSchema,
  quest_revision: z.number().int(),
  /** Null when the Quest has no plan. */
  plan: questPlanSchema.nullable(),
  /** The Quest's status after the checkpoint — `completed` when this checkpoint finished the plan. */
  quest_status: questStatusSchema,
  /**
   * Set when the plan finished but the Quest was left open, naming why. Same two reasons as
   * ending a session: the project is on `manual`, or another session is still attached.
   */
  quest_status_held: z.string().nullable(),
});
export type CreateCheckpointResponse = z.infer<typeof createCheckpointResponseSchema>;

// --- sessions --------------------------------------------------------------

export const sessionSchema = z.object({
  id: uuidSchema,
  project_id: uuidSchema,
  work_item_id: uuidSchema.nullable(),
  client: z.string(),
  agent: z.string().nullable(),
  state: sessionStateSchema,
  activation_mode: activationModeSchema.nullable(),
  initial_task: z.string().nullable(),
  started_memory_revision: z.number().int(),
  workspace_label: z.string().nullable(),
  started_at: isoTimestampSchema,
  activated_at: nullableIsoTimestampSchema,
  last_seen_at: nullableIsoTimestampSchema,
  ended_at: nullableIsoTimestampSchema,
});
export type SessionDto = z.infer<typeof sessionSchema>;

export const startSessionRequestSchema = z.object({
  project: z.string().min(1).max(300),
  client: z.string().min(1).max(100),
  agent: z.string().max(100).optional(),
  workspace_key: z.string().max(200).optional(),
  workspace_label: z.string().max(200).optional(),
});
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>;

export const startSessionResponseSchema = z.object({
  session_id: uuidSchema,
  state: sessionStateSchema,
  project: z.object({ id: uuidSchema, name: z.string() }),
  project_revision: z.number().int(),
  /** Short core context only. A handoff is never loaded at this stage. */
  core_context: z.string(),
  bootstrap_required: z.boolean(),
  bootstrap_plan: z.unknown().nullable(),
  /** Open Quests offered as suggestions, not attached. */
  open_quests: z.array(
    z.object({
      id: uuidSchema,
      title: z.string(),
      status: questStatusSchema,
      last_activity_at: isoTimestampSchema,
    }),
  ),
  agent_run_id: uuidSchema.nullable(),
});
export type StartSessionResponse = z.infer<typeof startSessionResponseSchema>;

export const MODE_HINTS = ['auto', 'new_work', 'resume_work', 'inquiry'] as const;
export const modeHintSchema = z.enum(MODE_HINTS);
export type ModeHint = z.infer<typeof modeHintSchema>;

export const activateSessionRequestSchema = z.object({
  task: z.string().min(1).max(8_000),
  mode_hint: modeHintSchema.optional(),
  requested_quest_id: uuidSchema.nullable().optional(),
  /** Declared up front so Party can warn about overlap before work starts. */
  scope: questScopeSchema.optional(),
  /**
   * The numbered sub-tasks this work breaks into, when they are already known. Ignored for an
   * `inquiry` activation, which creates no Quest, and never replaces the plan of a Quest being
   * resumed — use `PUT /api/quests/:questId/plan` for that.
   */
  plan: z.array(z.string().min(1).max(500)).max(50).optional(),
  token_budget: z.number().int().min(500).max(60_000).optional(),
});
export type ActivateSessionRequest = z.infer<typeof activateSessionRequestSchema>;

export const relatedQuestSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  status: questStatusSchema,
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  last_activity_at: isoTimestampSchema,
});
export type RelatedQuestDto = z.infer<typeof relatedQuestSchema>;

export const activateSessionResponseSchema = z.object({
  activation_mode: activationModeSchema,
  quest: questSchema.nullable(),
  context: z.object({
    core: z.string(),
    task: z.string().nullable(),
    continuation: z.unknown().nullable(),
    party: z.record(z.unknown()),
    warnings: z.array(z.string()),
  }),
  related_quests: z.array(relatedQuestSchema),
});
export type ActivateSessionResponse = z.infer<typeof activateSessionResponseSchema>;

export const promoteSessionRequestSchema = z.object({
  mode: z.enum(['new_work', 'resume_work']),
  task: z.string().max(8_000).optional(),
  requested_quest_id: uuidSchema.nullable().optional(),
  scope: questScopeSchema.optional(),
});
export type PromoteSessionRequest = z.infer<typeof promoteSessionRequestSchema>;

export const endSessionRequestSchema = z.object({
  /** Omitting the handoff is allowed only for an inquiry session with no Quest. */
  handoff: z
    .object({
      expected_quest_revision: z.number().int().nonnegative(),
      summary: z.string().min(1).max(2_000),
      work_state: workStateSchema,
      step_updates: z.array(stepUpdateSchema).max(50).default([]),
    })
    .optional(),
  /**
   * What the agent says has become of the Quest, as part of the same handoff.
   *
   * Only ever a declaration: nothing infers an outcome from the work state. The terminal
   * statuses (`completed`, `cancelled`) are additionally gated on the project's
   * `quest_completion_mode`, because they cannot be undone from the agent surface — a
   * completed Quest is outside the resumable set, and no MCP tool can reopen one.
   *
   * A finished plan closes the Quest on its own, through the handoff's `step_updates`, under
   * the same gate. This field stays the way to say anything else — `blocked`, `cancelled`, or
   * `completed` for a Quest that never declared a plan.
   */
  quest_status: questStatusSchema.optional(),
});
export type EndSessionRequest = z.infer<typeof endSessionRequestSchema>;

export const endSessionResponseSchema = z.object({
  session: sessionSchema,
  handoff: checkpointSchema.nullable(),
  quest_revision: z.number().int().nullable(),
  released_claims: z.number().int(),
  /** The Quest's status now. Null when the session owned no Quest. */
  quest_status: questStatusSchema.nullable(),
  /**
   * Set when a status was recorded but not applied, naming why — the project is on `manual`, or
   * another session is still attached to the Quest. Reports a finished plan that was held back
   * as well as a declared `quest_status`. Null when nothing was held.
   */
  quest_status_held: z.string().nullable(),
  /** The Quest's plan as the handoff left it. Null when it has none. */
  plan: questPlanSchema.nullable(),
});
export type EndSessionResponse = z.infer<typeof endSessionResponseSchema>;

// --- continuation ----------------------------------------------------------

export const continuationSchema = z.object({
  summary: z.string(),
  checkpoint_id: uuidSchema,
  quest_revision: z.number().int(),
  recorded_at: isoTimestampSchema,
  /** True when no clean final handoff existed and the latest checkpoint was used instead. */
  recovered_from_interrupted_session: z.boolean(),
  /**
   * The Quest's plan as it stands, so a resuming session picks up at the first unsettled step
   * rather than re-reading a free-text handoff to work out where it is. Null when there is none.
   */
  plan: questPlanSchema.nullable(),
  next_steps: z.array(z.string()),
  blockers: z.array(z.record(z.unknown())),
  rendered: z.string(),
});
export type ContinuationDto = z.infer<typeof continuationSchema>;

export { contextModeSchema };
