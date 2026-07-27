import type {
  CheckpointDto,
  QuestDependencyDto,
  QuestDto,
  SessionDto,
} from '@saga/contracts';
import type { Checkpoint, Quest, QuestDependency, QuestSession } from '@saga/quest';
import { toIso, toIsoRequired } from '@saga/shared';

export function presentQuest(quest: Quest): QuestDto {
  return {
    id: quest.id,
    project_id: quest.projectId,
    parent_work_item_id: quest.parentWorkItemId,
    title: quest.title,
    objective: quest.objective,
    status: quest.status,
    priority: quest.priority,
    scope: quest.scope,
    revision: quest.revision,
    latest_checkpoint_id: quest.latestCheckpointId,
    created_at: toIsoRequired(quest.createdAt),
    last_activity_at: toIsoRequired(quest.lastActivityAt),
    completed_at: toIso(quest.completedAt),
    archived_at: toIso(quest.archivedAt),
  };
}

export function presentCheckpoint(checkpoint: Checkpoint): CheckpointDto {
  return {
    id: checkpoint.id,
    session_id: checkpoint.sessionId,
    work_item_id: checkpoint.workItemId,
    base_work_item_revision: checkpoint.baseWorkItemRevision,
    sequence: checkpoint.sequence,
    kind: checkpoint.kind,
    summary: checkpoint.summary,
    work_state: checkpoint.workState,
    created_at: toIsoRequired(checkpoint.createdAt),
  };
}

export function presentSession(session: QuestSession): SessionDto {
  return {
    id: session.id,
    project_id: session.projectId,
    work_item_id: session.workItemId,
    client: session.client,
    agent: session.agent,
    state: session.state,
    activation_mode: session.activationMode,
    initial_task: session.initialTask,
    started_memory_revision: session.startedMemoryRevision,
    // The label is shown; `workspace_key` is a machine identity and is never exposed.
    workspace_label: session.workspaceLabel,
    started_at: toIsoRequired(session.startedAt),
    activated_at: toIso(session.activatedAt),
    last_seen_at: toIso(session.lastSeenAt),
    ended_at: toIso(session.endedAt),
  };
}

export function presentDependency(dependency: QuestDependency): QuestDependencyDto {
  return {
    work_item_id: dependency.workItemId,
    depends_on_work_item_id: dependency.dependsOnWorkItemId,
    depends_on_title: dependency.dependsOnTitle,
    depends_on_status: dependency.dependsOnStatus,
    dependency_type: dependency.dependencyType,
    created_at: toIsoRequired(dependency.createdAt),
  };
}
