export type ProjectStatus = 'active' | 'archived';
export type LoreApprovalMode = 'auto' | 'manual';
/** Whether an agent may close its own Quest, or a person does it in Guild Hall. */
export type QuestCompletionMode = 'auto' | 'manual';

export interface Project {
  id: string;
  name: string;
  nameKey: string;
  description: string | null;
  status: ProjectStatus;
  memoryRevision: number;
  activeContextSnapshotId: string | null;
  loreApprovalMode: LoreApprovalMode;
  questCompletionMode: QuestCompletionMode;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectAlias {
  id: string;
  projectId: string;
  alias: string;
  aliasKey: string;
  createdAt: Date;
}

export interface ProjectWithAliases extends Project {
  aliases: string[];
}

export const OUTBOX_TOPICS = [
  'lore.memory_published',
  'lore.memory_marked_stale',
  'lore.memory_archived',
  'quest.checkpoint_created',
  'quest.status_changed',
  'quest.completed',
  'quest.session_started',
  'quest.session_abandoned',
  'quest.session_ended',
  'party.agent_started',
  'party.agent_expired',
  'party.agent_ended',
  'party.claim_acquired',
  'party.claim_released',
  'party.claim_revoked',
  'shrine.job_failed',
  'shrine.job_state_changed',
  'core.project_created',
  'core.project_renamed',
  'core.project_archived',
  'core.project_restored',
] as const;

export type OutboxTopic = (typeof OUTBOX_TOPICS)[number];

export type OutboxState = 'pending' | 'processing' | 'published' | 'failed';

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string | null;
  topic: OutboxTopic;
  payload: Record<string, unknown>;
  state: OutboxState;
  attempts: number;
  availableAt: Date;
  createdAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
  correlationId: string | null;
  projectId: string | null;
}

export interface NewOutboxEvent {
  aggregateType: string;
  aggregateId?: string | null;
  topic: OutboxTopic;
  payload: Record<string, unknown>;
  correlationId?: string | null;
  projectId?: string | null;
}
