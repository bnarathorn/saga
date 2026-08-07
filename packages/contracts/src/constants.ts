/**
 * Enum value lists, with no Zod import.
 *
 * Guild Hall needs a few of these at runtime — to render a `<select>`, to lay out a board
 * column per status, to default a set of checkboxes. Importing them from the package barrel
 * instead would pull the whole Zod runtime and every server-side schema into the browser bundle
 * (measured: ~20 KB gzip), so the lists live here and the schema modules build their
 * `z.enum(...)` from them.
 *
 * Rule for this file: value declarations only, and no import that is not itself type-only.
 */

export const MEMORY_CATEGORIES = [
  'overview',
  'structure',
  'coding_style',
  'config',
  'running',
  'deploy',
  'debug',
  'logs',
  'testing',
  'server',
  'database',
  'api',
  'decision',
  'warning',
] as const;

export const MEMORY_KINDS = [
  'fact',
  'procedure',
  'convention',
  'map',
  'entity',
  'decision',
  'warning',
] as const;

export const MEMORY_STATES = ['active', 'stale', 'archived'] as const;

export const VERIFICATION_STATES = ['observed', 'inferred', 'verified'] as const;

export const VOLATILITIES = ['stable', 'operational'] as const;

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
  'quest_plan_sweeper',
  'relation_inference',
] as const;

export const JOB_STATES = [
  'queued',
  'claimed',
  'retrying',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const MEMORY_RELATIONS = [
  'uses',
  'exposes',
  'calls',
  'depends_on',
  'deployed_to',
  'configured_by',
  'tested_by',
  'logs_to',
  'relates_to',
] as const;

/**
 * `confirmed` relations are the graph: search traverses them and Guild Hall draws them.
 * `proposed` ones are suggestions waiting on a person. `rejected` ones are suggestions somebody
 * turned down, kept as rows so the inference job cannot propose them again on the next publish.
 */
export const MEMORY_LINK_STATES = ['proposed', 'confirmed', 'rejected'] as const;

/**
 * Who decided the relation. Only `model` is ever `proposed` — a person creating a relation is
 * the confirmation, and a `[[key]]` or bare-key match is confirmed by the text it was read out
 * of.
 */
export const MEMORY_LINK_SOURCES = ['human', 'deterministic', 'model'] as const;
