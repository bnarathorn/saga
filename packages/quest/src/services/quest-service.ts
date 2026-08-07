import type {
  CheckpointKind,
  ContinuationDto,
  DependencyType,
  QuestPlanDto,
  QuestPriority,
  QuestScope,
  QuestStatus,
  StepUpdate,
  WorkState,
} from '@saga/contracts';
import type { OutboxRepository, Project, ProjectRepository } from '@saga/core';
import type { Queryable, SagaPool } from '@saga/database';
import { acquireAdvisoryLock, withTransaction } from '@saga/database';
import {
  SagaError,
  buildPage,
  decodeCursor,
  estimateTokens,
  truncateToTokens,
  type Page,
} from '@saga/shared';
import type { JobService } from '@saga/shrine';
import { planCompletesQuest, reconcilePlan, summarisePlan } from '../domain/plan.js';
import {
  canTransitionStatus,
  projectParentStatus,
  wouldCreateCycle,
} from '../domain/projection.js';
import {
  type QuestRepository,
  type Checkpoint,
  type Quest,
  type QuestDependency,
  type QuestStep,
} from '../repositories/quest-repository.js';

/**
 * One lock namespace per project for every change to the Quest graph. Acyclicity spans many
 * rows, so it cannot be a database constraint.
 */
const QUEST_GRAPH_LOCK = 'quest.graph';

export interface QuestServiceDeps {
  pool: SagaPool;
  quests: QuestRepository;
  projects: ProjectRepository;
  outbox: OutboxRepository;
  jobs: JobService;
}

export interface CreateQuestInput {
  project: Project;
  title: string;
  objective?: string | null;
  priority?: QuestPriority;
  scope?: QuestScope;
  parentWorkItemId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
}

/**
 * Owns every Quest and checkpoint state transition. Checkpoint creation is the only place
 * `quest.work_items.revision` moves, and it moves exactly once per checkpoint.
 */
export class QuestService {
  constructor(private readonly deps: QuestServiceDeps) {}

  // --- quests --------------------------------------------------------------

  async create(input: CreateQuestInput): Promise<Quest> {
    if (input.project.status === 'archived') {
      throw new SagaError(
        'PROJECT_ARCHIVED',
        `The project "${input.project.name}" is archived and is read-only.`,
      );
    }

    return withTransaction(this.deps.pool, async (tx) => {
      if (input.parentWorkItemId != null) {
        await this.assertParentUsable(tx, input.project.id, input.parentWorkItemId, null);
      }

      const quest = await this.deps.quests.create(tx, {
        projectId: input.project.id,
        title: input.title.trim(),
        objective: input.objective ?? null,
        priority: input.priority ?? 'normal',
        scope: input.scope ?? {},
        parentWorkItemId: input.parentWorkItemId ?? null,
        createdBySessionId: input.sessionId ?? null,
        searchText: questSearchText(input.title, input.objective ?? null, input.scope ?? {}),
      });

      await this.deps.jobs.enqueueIn(tx, {
        projectId: input.project.id,
        jobType: 'embedding',
        entityType: 'work_item',
        entityId: quest.id,
        dedupeKey: `quest:${quest.id}`,
        payload: { work_item_id: quest.id },
        correlationId: input.correlationId ?? null,
        priority: 3,
      });

      if (quest.parentWorkItemId !== null) {
        await this.reprojectParent(tx, quest.parentWorkItemId, input.correlationId ?? null);
      }

      return quest;
    });
  }

  async get(id: string): Promise<Quest> {
    const quest = await this.deps.quests.findById(this.deps.pool, id);
    if (quest === null) {
      throw new SagaError('QUEST_NOT_FOUND', 'No Quest matches that id.', {
        details: { quest_id: id },
      });
    }
    return quest;
  }

  async list(filter: {
    projectId: string;
    status?: QuestStatus;
    priority?: QuestPriority;
    parentWorkItemId?: string;
    includeArchived?: boolean;
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<Page<Quest>> {
    const cursor = filter.cursor === undefined ? null : decodeCursor(filter.cursor);
    const rows = await this.deps.quests.list(this.deps.pool, {
      ...filter,
      cursorKey: cursor?.k,
      cursorId: cursor?.id,
      limit: filter.limit + 1,
    });
    return buildPage(rows, filter.limit, (quest) => ({
      k: quest.lastActivityAt.toISOString(),
      id: quest.id,
    }));
  }

  async update(
    id: string,
    fields: {
      title?: string;
      objective?: string | null;
      status?: QuestStatus;
      priority?: QuestPriority;
      scope?: QuestScope;
      parentWorkItemId?: string | null;
    },
    correlationId?: string | null,
  ): Promise<Quest> {
    return withTransaction(this.deps.pool, async (tx) => {
      const current = await this.deps.quests.lockById(tx, id);
      if (current === null) throw new SagaError('QUEST_NOT_FOUND', 'No Quest matches that id.');

      if (fields.status !== undefined && !canTransitionStatus(current.status, fields.status)) {
        throw new SagaError(
          'QUEST_STATE_INVALID',
          `A ${current.status} Quest cannot move directly to ${fields.status}.`,
          { details: { from: current.status, to: fields.status } },
        );
      }

      if (fields.parentWorkItemId !== undefined && fields.parentWorkItemId !== null) {
        await this.assertParentUsable(tx, current.projectId, fields.parentWorkItemId, id);
      }

      const searchText =
        fields.title !== undefined || fields.objective !== undefined || fields.scope !== undefined
          ? questSearchText(
              fields.title ?? current.title,
              fields.objective === undefined ? current.objective : fields.objective,
              fields.scope ?? current.scope,
            )
          : undefined;

      const updated = await this.deps.quests.update(tx, id, {
        ...fields,
        // An explicit status change is a human decision that projection must not undo.
        statusSetManually: fields.status === undefined ? undefined : true,
        searchText,
      });

      if (searchText !== undefined) {
        await this.deps.jobs.enqueueIn(tx, {
          projectId: current.projectId,
          jobType: 'embedding',
          entityType: 'work_item',
          entityId: id,
          dedupeKey: `quest:${id}`,
          payload: { work_item_id: id },
          correlationId: correlationId ?? null,
          priority: 3,
        });
      }

      if (fields.status !== undefined && fields.status !== current.status) {
        await this.deps.outbox.emit(tx, {
          aggregateType: 'work_item',
          aggregateId: id,
          topic: fields.status === 'completed' ? 'quest.completed' : 'quest.status_changed',
          payload: { title: updated.title, from: current.status, to: fields.status },
          correlationId: correlationId ?? null,
          projectId: current.projectId,
        });

        // Both the old and the new parent may need re-projecting.
        for (const parentId of new Set(
          [current.parentWorkItemId, updated.parentWorkItemId].filter(
            (value): value is string => value !== null,
          ),
        )) {
          await this.reprojectParent(tx, parentId, correlationId ?? null);
        }
      }

      return updated;
    });
  }

  async archive(id: string): Promise<Quest> {
    return withTransaction(this.deps.pool, async (tx) => {
      const quest = await this.deps.quests.lockById(tx, id);
      if (quest === null) throw new SagaError('QUEST_NOT_FOUND', 'No Quest matches that id.');
      if (quest.status !== 'completed' && quest.status !== 'cancelled') {
        throw new SagaError(
          'QUEST_STATE_INVALID',
          'Only a completed or cancelled Quest can be archived. Complete or cancel it first.',
          { details: { status: quest.status } },
        );
      }
      return this.deps.quests.setArchived(tx, id, true);
    });
  }

  /** Reopening is explicit and always confirmed by the caller. */
  async reopen(id: string, correlationId?: string | null): Promise<Quest> {
    return withTransaction(this.deps.pool, async (tx) => {
      const quest = await this.deps.quests.lockById(tx, id);
      if (quest === null) throw new SagaError('QUEST_NOT_FOUND', 'No Quest matches that id.');
      if (quest.status !== 'completed' && quest.status !== 'cancelled') {
        throw new SagaError(
          'QUEST_STATE_INVALID',
          `Only a completed or cancelled Quest can be reopened; this one is ${quest.status}.`,
        );
      }
      await this.deps.quests.update(tx, id, {
        status: 'in_progress',
        statusSetManually: true,
      });
      // Un-archive last so the returned row reflects both changes.
      const reopened = await this.deps.quests.setArchived(tx, id, false);
      await this.deps.outbox.emit(tx, {
        aggregateType: 'work_item',
        aggregateId: id,
        topic: 'quest.status_changed',
        payload: { title: quest.title, from: quest.status, to: 'in_progress', reopened: true },
        correlationId: correlationId ?? null,
        projectId: quest.projectId,
      });
      return reopened;
    });
  }

  // --- plan ----------------------------------------------------------------

  async getPlan(workItemId: string): Promise<QuestPlanDto> {
    const steps = await this.deps.quests.listSteps(this.deps.pool, workItemId);
    return toPlanDto(steps);
  }

  /**
   * Declare or re-declare a Quest's numbered plan.
   *
   * Held under the Quest row lock, because the plan and the status derived from it must move
   * together: without it a checkpoint could settle the last step of a plan that is halfway
   * through being replaced, and close the Quest against a plan that no longer exists.
   *
   * Replacing a plan never closes a Quest by itself, even when every carried-over step is
   * already done. Closing is something a session does through a checkpoint, or the sweeper does
   * once nobody is attached — both of which see the new plan on their next pass.
   */
  async setPlan(
    workItemId: string,
    titles: readonly string[],
    correlationId?: string | null,
  ): Promise<QuestPlanDto> {
    return withTransaction(this.deps.pool, async (tx) => {
      const quest = await this.deps.quests.lockById(tx, workItemId);
      if (quest === null) throw new SagaError('QUEST_NOT_FOUND', 'No Quest matches that id.');
      if (quest.status === 'completed' || quest.status === 'cancelled') {
        throw new SagaError(
          'QUEST_STATE_INVALID',
          `A ${quest.status} Quest cannot take a new plan. Reopen it first.`,
          { details: { status: quest.status } },
        );
      }

      const existing = await this.deps.quests.listSteps(tx, workItemId);
      const reconciled = reconcilePlan(existing, titles);
      const steps = await this.deps.quests.replaceSteps(tx, workItemId, reconciled);

      await this.deps.outbox.emit(tx, {
        aggregateType: 'work_item',
        aggregateId: workItemId,
        topic: 'quest.plan_declared',
        payload: {
          title: quest.title,
          steps: steps.length,
          carried_over: reconciled.filter((step) => step.carriedFromId !== null).length,
        },
        correlationId: correlationId ?? null,
        projectId: quest.projectId,
      });

      return toPlanDto(steps);
    });
  }

  // --- dependencies --------------------------------------------------------

  async addDependency(
    workItemId: string,
    dependsOnWorkItemId: string,
    dependencyType: DependencyType,
  ): Promise<QuestDependency[]> {
    return withTransaction(this.deps.pool, async (tx) => {
      const [quest, dependsOn] = await Promise.all([
        this.deps.quests.findById(tx, workItemId),
        this.deps.quests.findById(tx, dependsOnWorkItemId),
      ]);
      if (quest === null || dependsOn === null) {
        throw new SagaError('QUEST_NOT_FOUND', 'One of the Quests does not exist.');
      }
      if (quest.projectId !== dependsOn.projectId) {
        throw new SagaError('QUEST_DEPENDENCY_INVALID', 'A dependency cannot cross projects.', {
          details: { work_item_id: workItemId, depends_on: dependsOnWorkItemId },
        });
      }
      if (workItemId === dependsOnWorkItemId) {
        throw new SagaError('QUEST_DEPENDENCY_INVALID', 'A Quest cannot depend on itself.');
      }

      // The acyclicity check reads the whole edge set and then adds an edge. Two concurrent
      // additions each see an acyclic graph and together create the cycle neither could see,
      // and nothing downstream re-checks. The lock is per project, so unrelated projects are
      // unaffected and ordinary Quest work never touches it.
      await acquireAdvisoryLock(tx, `${QUEST_GRAPH_LOCK}:${quest.projectId}`);

      const edges = await this.deps.quests.dependencyEdges(tx, quest.projectId);
      if (wouldCreateCycle(edges, workItemId, dependsOnWorkItemId)) {
        throw new SagaError(
          'QUEST_DEPENDENCY_INVALID',
          'That dependency would create a cycle in the Quest graph.',
          { details: { work_item_id: workItemId, depends_on: dependsOnWorkItemId } },
        );
      }

      await this.deps.quests.addDependency(tx, {
        workItemId,
        dependsOnWorkItemId,
        dependencyType,
      });
      return this.deps.quests.listDependencies(tx, workItemId);
    });
  }

  async removeDependency(workItemId: string, dependsOnId: string): Promise<void> {
    const removed = await withTransaction(this.deps.pool, (tx) =>
      this.deps.quests.removeDependency(tx, workItemId, dependsOnId),
    );
    if (!removed) throw new SagaError('NOT_FOUND', 'That dependency does not exist.');
  }

  async listDependencies(workItemId: string): Promise<QuestDependency[]> {
    return this.deps.quests.listDependencies(this.deps.pool, workItemId);
  }

  async listChildren(id: string): Promise<Quest[]> {
    return this.deps.quests.listChildren(this.deps.pool, id);
  }

  // --- checkpoints ---------------------------------------------------------

  /**
   * Append a checkpoint under compare-and-swap on the Quest revision (spec 7.13).
   *
   * Within one transaction: lock the Quest, reject a stale expected revision, insert the
   * append-only checkpoint, settle any plan steps the checkpoint reports, set
   * `latest_checkpoint_id`, increment the revision exactly once, touch `last_activity_at`,
   * close the Quest if that settled the last step, and emit the outbox events.
   *
   * The step updates share the checkpoint's transaction on purpose: a step recorded as done
   * without the checkpoint that says why is a completion nobody can audit, and a Quest closed
   * against steps that then roll back is worse still.
   */
  async createCheckpoint(input: {
    sessionId: string;
    expectedQuestRevision: number;
    kind: CheckpointKind;
    summary: string;
    workState: WorkState;
    stepUpdates?: readonly StepUpdate[];
    correlationId?: string | null;
  }): Promise<{
    checkpoint: Checkpoint;
    questRevision: number;
    plan: QuestPlanDto | null;
    questStatus: QuestStatus;
    questStatusHeld: string | null;
  }> {
    return withTransaction(this.deps.pool, async (tx) => {
      const session = await this.deps.quests.lockSessionById(tx, input.sessionId);
      if (session === null) {
        throw new SagaError('SESSION_NOT_FOUND', 'No session matches that id.');
      }
      if (session.workItemId === null) {
        throw new SagaError(
          'SESSION_STATE_INVALID',
          'This session has no Quest yet. Activate it as new_work or resume_work, or promote it from inquiry, before recording a checkpoint.',
          { details: { session_id: input.sessionId, state: session.state } },
        );
      }
      if (session.state === 'completed' || session.state === 'abandoned') {
        throw new SagaError(
          'SESSION_STATE_INVALID',
          `A ${session.state} session cannot record further checkpoints.`,
          { details: { state: session.state } },
        );
      }

      const quest = await this.deps.quests.lockById(tx, session.workItemId);
      if (quest === null) throw new SagaError('QUEST_NOT_FOUND', 'The Quest no longer exists.');

      if (quest.revision !== input.expectedQuestRevision) {
        // Never silently overwrite the latest checkpoint: the caller must re-read first.
        throw new SagaError(
          'QUEST_REVISION_CONFLICT',
          'The Quest changed since this checkpoint was prepared. Re-read the latest checkpoint and try again.',
          {
            details: {
              expected_revision: input.expectedQuestRevision,
              latest_revision: quest.revision,
              latest_checkpoint_id: quest.latestCheckpointId,
            },
          },
        );
      }

      const checkpoint = await this.deps.quests.insertCheckpoint(tx, {
        sessionId: input.sessionId,
        workItemId: quest.id,
        baseWorkItemRevision: input.expectedQuestRevision,
        kind: input.kind,
        summary: input.summary,
        workState: input.workState,
      });

      const advanced = await this.deps.quests.advanceRevision(
        tx,
        quest.id,
        input.expectedQuestRevision,
        checkpoint.id,
      );
      if (advanced === null) {
        // Unreachable while the row lock is held, but a wrong answer here would be silent
        // data loss, so it fails loudly rather than assuming.
        throw new SagaError(
          'QUEST_REVISION_CONFLICT',
          'The Quest revision moved while the checkpoint was being written.',
        );
      }

      const steps = await this.applyStepUpdates(tx, {
        quest,
        sessionId: input.sessionId,
        checkpointId: checkpoint.id,
        updates: input.stepUpdates ?? [],
      });

      await this.deps.quests.touchSession(tx, input.sessionId);

      await this.deps.outbox.emit(tx, {
        aggregateType: 'work_item',
        aggregateId: quest.id,
        topic: 'quest.checkpoint_created',
        payload: {
          title: quest.title,
          kind: input.kind,
          checkpoint_id: checkpoint.id,
          quest_revision: advanced.revision,
          session_id: input.sessionId,
          steps_settled: (input.stepUpdates ?? []).length,
        },
        correlationId: input.correlationId ?? null,
        projectId: quest.projectId,
      });

      const completion = await this.completeIfPlanFinished(tx, {
        // `advanced` carries the revision this checkpoint just wrote; `quest` is one behind.
        quest: advanced,
        steps,
        excludeSessionId: input.sessionId,
        reason: 'plan_complete',
        correlationId: input.correlationId ?? null,
      });

      return {
        checkpoint,
        questRevision: advanced.revision,
        plan: steps.length === 0 ? null : toPlanDto(steps),
        questStatus: completion.status,
        questStatusHeld: completion.held,
      };
    });
  }

  /**
   * Settle the steps a checkpoint reports, and return the plan as it stands afterwards.
   *
   * An ordinal that is not in the plan is an error rather than a no-op: an agent ticking off a
   * step the Quest does not have has lost track of which plan it is working to, and silently
   * dropping the update would let it believe it had finished.
   */
  private async applyStepUpdates(
    tx: Queryable,
    input: {
      quest: Quest;
      sessionId: string | null;
      checkpointId: string | null;
      updates: readonly StepUpdate[];
    },
  ): Promise<QuestStep[]> {
    for (const update of input.updates) {
      const settled = await this.deps.quests.setStepStatus(tx, {
        workItemId: input.quest.id,
        ordinal: update.ordinal,
        status: update.status ?? 'done',
        sessionId: input.sessionId,
        checkpointId: input.checkpointId,
      });
      if (settled === null) {
        throw new SagaError(
          'QUEST_STEP_NOT_FOUND',
          `This Quest has no step ${update.ordinal}. Re-read the plan before settling steps.`,
          { details: { work_item_id: input.quest.id, ordinal: update.ordinal } },
        );
      }
    }
    return this.deps.quests.listSteps(tx, input.quest.id);
  }

  /**
   * Close a Quest whose plan has finished, or say why it was left open.
   *
   * The same two gates that guard a declared `quest_status` on `saga_end_session`, for the same
   * reason: closing is one-way from the agent surface, so a wrong close silently forks the work
   * (ADR-0010, ADR-0011).
   *
   *   1. The project must be on `quest_completion_mode = 'auto'`.
   *   2. No other session may still be attached — Quest-to-session is one-to-many, so one agent
   *      finishing its own steps is not the work being finished.
   *
   * The caller must hold the Quest row lock. That is what makes gate 2 sound for the sweeper,
   * which reads its candidates outside any transaction: a session that attached in between is
   * seen here, under the lock, before anything is written.
   */
  private async completeIfPlanFinished(
    tx: Queryable,
    input: {
      quest: Quest;
      steps: readonly QuestStep[];
      excludeSessionId?: string;
      reason: string;
      correlationId: string | null;
    },
  ): Promise<{ status: QuestStatus; held: string | null; completed: boolean }> {
    const unchanged = { status: input.quest.status, held: null, completed: false };

    if (!planCompletesQuest(input.steps)) return unchanged;
    if (input.quest.status === 'completed' || input.quest.status === 'cancelled') return unchanged;
    if (!canTransitionStatus(input.quest.status, 'completed')) return unchanged;

    const project = await this.deps.projects.findById(tx, input.quest.projectId);
    if (project?.questCompletionMode !== 'auto') {
      return {
        status: input.quest.status,
        held: `Every step of the plan is settled, but the project is on quest_completion_mode "manual", so the Quest was left open for Guild Hall.`,
        completed: false,
      };
    }

    const live = await this.deps.quests.hasLiveSession(tx, input.quest.id, input.excludeSessionId);
    if (live) {
      return {
        status: input.quest.status,
        held: 'Every step of the plan is settled, but another session is still attached to this Quest, so it was left open.',
        completed: false,
      };
    }

    const updated = await this.deps.quests.update(tx, input.quest.id, {
      status: 'completed',
      // The plan was declared by hand and settled item by item; projection from children must
      // not quietly reopen what that decided.
      statusSetManually: true,
    });

    await this.deps.outbox.emit(tx, {
      aggregateType: 'work_item',
      aggregateId: input.quest.id,
      topic: 'quest.completed',
      payload: {
        title: updated.title,
        from: input.quest.status,
        to: 'completed',
        reason: input.reason,
        steps: input.steps.length,
        steps_done: input.steps.filter((step) => step.status === 'done').length,
      },
      correlationId: input.correlationId,
      projectId: input.quest.projectId,
    });

    if (updated.parentWorkItemId !== null) {
      await this.reprojectParent(tx, updated.parentWorkItemId, input.correlationId);
    }

    return { status: 'completed', held: null, completed: true };
  }

  /**
   * Close every Quest whose plan has finished and whose sessions have all gone. Called by the
   * worker.
   *
   * This is the half of plan-driven completion that survives a crash. A session that settles its
   * last step and then dies — no final handoff, no `saga_end_session` — leaves a Quest that is
   * demonstrably finished and permanently `in_progress`, which is exactly what keeps stale
   * Quests eligible as resume candidates.
   */
  async sweepCompletedPlans(limit = 50): Promise<{ completed: string[]; held: number }> {
    const candidates = await this.deps.quests.findSweepableQuests(this.deps.pool, limit);
    if (candidates.length === 0) return { completed: [], held: 0 };

    const completed: string[] = [];
    let held = 0;

    for (const candidate of candidates) {
      // One transaction per Quest: a Quest that has since been picked up must not roll back the
      // ones already swept.
      const result = await withTransaction(this.deps.pool, async (tx) => {
        const quest = await this.deps.quests.lockById(tx, candidate.id);
        if (quest === null) return null;
        const steps = await this.deps.quests.listSteps(tx, quest.id);
        return this.completeIfPlanFinished(tx, {
          quest,
          steps,
          reason: 'plan_complete_swept',
          correlationId: null,
        });
      });

      if (result === null) continue;
      if (result.completed) completed.push(candidate.id);
      else held += 1;
    }

    return { completed, held };
  }

  async listCheckpoints(workItemId: string, limit = 50): Promise<Checkpoint[]> {
    return this.deps.quests.listCheckpoints(this.deps.pool, workItemId, limit);
  }

  async listSessions(
    workItemId: string,
  ): Promise<Awaited<ReturnType<QuestRepository['listSessionsForQuest']>>> {
    return this.deps.quests.listSessionsForQuest(this.deps.pool, workItemId);
  }

  /** The continuation record a resuming session should read. */
  async continuation(workItemId: string, tokenBudget: number): Promise<ContinuationDto | null> {
    const found = await this.deps.quests.findContinuation(this.deps.pool, workItemId);
    if (found === null) return null;
    const [quest, steps] = await Promise.all([
      this.deps.quests.findById(this.deps.pool, workItemId),
      this.deps.quests.listSteps(this.deps.pool, workItemId),
    ]);

    // The plan is read live rather than from the checkpoint's work state: steps settle under
    // their own transaction, and a resuming session needs where the Quest *is*, not where the
    // last author thought it was.
    const plan = steps.length === 0 ? null : toPlanDto(steps);

    const rendered = renderContinuation(
      found.checkpoint,
      quest?.title ?? 'this Quest',
      found.recovered,
      tokenBudget,
      plan,
    );

    return {
      summary: found.checkpoint.summary,
      checkpoint_id: found.checkpoint.id,
      quest_revision: found.checkpoint.baseWorkItemRevision + 1,
      recorded_at: found.checkpoint.createdAt.toISOString(),
      recovered_from_interrupted_session: found.recovered,
      plan,
      next_steps: found.checkpoint.workState.next_steps,
      blockers: found.checkpoint.workState.blockers as unknown as Record<string, unknown>[],
      rendered,
    };
  }

  // --- helpers -------------------------------------------------------------

  /**
   * Re-derive a parent's status from its children after a child changes. Never overwrites a
   * manually set or cancelled parent (see `projectParentStatus`).
   */
  private async reprojectParent(
    tx: Queryable,
    parentId: string,
    correlationId: string | null,
  ): Promise<void> {
    const parent = await this.deps.quests.lockById(tx, parentId);
    if (parent === null) return;

    const children = await this.deps.quests.listChildren(tx, parentId);
    const projection = projectParentStatus({
      currentParentStatus: parent.status,
      parentStatusSetManually: parent.statusSetManually,
      children: children.map((child) => ({ status: child.status })),
    });
    if (!projection.changed) return;

    await this.deps.quests.update(tx, parentId, { status: projection.status });
    await this.deps.outbox.emit(tx, {
      aggregateType: 'work_item',
      aggregateId: parentId,
      topic: projection.status === 'completed' ? 'quest.completed' : 'quest.status_changed',
      payload: {
        title: parent.title,
        from: parent.status,
        to: projection.status,
        projected_from_children: true,
        reason: projection.reason,
      },
      correlationId,
      projectId: parent.projectId,
    });

    // A Questline may be several levels deep; the change propagates upwards.
    if (parent.parentWorkItemId !== null) {
      await this.reprojectParent(tx, parent.parentWorkItemId, correlationId);
    }
  }

  private async assertParentUsable(
    tx: Queryable,
    projectId: string,
    parentId: string,
    childId: string | null,
  ): Promise<void> {
    const parent = await this.deps.quests.findById(tx, parentId);
    if (parent === null) {
      throw new SagaError('QUEST_PARENT_INVALID', 'The parent Quest does not exist.');
    }
    if (parent.projectId !== projectId) {
      throw new SagaError(
        'QUEST_PARENT_INVALID',
        'A parent Quest must belong to the same project.',
        { details: { parent_work_item_id: parentId } },
      );
    }
    if (childId !== null) {
      // Same read-then-write race as `addDependency`, on the parent graph; same lock, so a
      // reparent and a dependency addition cannot interleave either.
      await acquireAdvisoryLock(tx, `${QUEST_GRAPH_LOCK}:${projectId}`);
      const edges = await this.deps.quests.parentEdges(tx, projectId);
      if (wouldCreateCycle(edges, childId, parentId)) {
        throw new SagaError(
          'QUEST_PARENT_INVALID',
          'That parent would create a cycle in the Questline.',
          { details: { parent_work_item_id: parentId } },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------

export function toPlanDto(steps: readonly QuestStep[]): QuestPlanDto {
  return {
    steps: steps.map((step) => ({
      id: step.id,
      work_item_id: step.workItemId,
      ordinal: step.ordinal,
      title: step.title,
      status: step.status,
      completed_at: step.completedAt?.toISOString() ?? null,
      completed_by_session_id: step.completedBySessionId,
      completed_by_checkpoint_id: step.completedByCheckpointId,
      created_at: step.createdAt.toISOString(),
      updated_at: step.updatedAt.toISOString(),
    })),
    progress: summarisePlan(steps),
  };
}

export function questSearchText(
  title: string,
  objective: string | null,
  scope: QuestScope,
): string {
  const parts = [title, objective ?? ''];
  for (const values of Object.values(scope)) {
    if (Array.isArray(values)) parts.push(...values.map(String));
  }
  return parts.filter((part) => part.length > 0).join('\n');
}

/**
 * Render a checkpoint as the continuation an agent reads on resume. Sections are ordered so
 * that a trimmed rendering still carries next steps and blockers.
 */
export function renderContinuation(
  checkpoint: Checkpoint,
  questTitle: string,
  recovered: boolean,
  tokenBudget: number,
  plan: QuestPlanDto | null = null,
): string {
  const state = checkpoint.workState;
  const lines: string[] = [`## Continuing: ${questTitle}`, ''];

  if (recovered) {
    lines.push(
      '> Recovered from an interrupted session: no final handoff was recorded, so this is the latest checkpoint.',
      '',
    );
  }

  lines.push(`**Goal.** ${state.goal}`, '', `**Last recorded.** ${checkpoint.summary}`, '');

  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`### ${title}`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  };

  // The plan comes first and is never trimmed away: it is the only part of a continuation that
  // says what finishing this Quest actually requires, and it is what the resuming session will
  // settle to close it.
  if (plan !== null) {
    const marks: Record<string, string> = {
      done: '[x]',
      skipped: '[-]',
      in_progress: '[~]',
      pending: '[ ]',
    };
    lines.push(`### Plan — ${plan.progress.done}/${plan.progress.total} done`);
    for (const step of plan.steps) {
      lines.push(`- ${marks[step.status]} ${step.ordinal}. ${step.title}`);
    }
    lines.push(
      '',
      plan.progress.next_ordinal === null
        ? 'Every step is settled. This Quest closes on the next checkpoint or the next sweep.'
        : `Resume at step ${plan.progress.next_ordinal}. Settle each step with \`step_updates\` on saga_checkpoint; the Quest completes when the last one is settled, whatever next steps remain.`,
      '',
    );
  }

  // Ordered by what a resuming agent needs first.
  section('Next steps', state.next_steps);
  section(
    'Blockers',
    state.blockers.map((blocker) =>
      blocker.suggested_action === undefined
        ? blocker.description
        : `${blocker.description} — suggested: ${blocker.suggested_action}`,
    ),
  );
  section('In progress', state.in_progress);
  section(
    'Decisions',
    state.decisions.map((decision) =>
      decision.reason === undefined
        ? decision.decision
        : `${decision.decision} (${decision.reason})`,
    ),
  );
  section('Completed', state.completed);
  section(
    'Changed files',
    state.changed_files.map((file) =>
      file.current_hash === undefined
        ? file.path
        : `${file.path} (${file.current_hash.slice(0, 16)})`,
    ),
  );
  section(
    'Commands already attempted',
    state.commands.map((command) =>
      command.status === undefined
        ? command.command
        : `\`${command.command}\` → ${command.status}${command.summary === undefined ? '' : `: ${command.summary}`}`,
    ),
  );
  section(
    'Test results',
    state.tests.map(
      (test) =>
        `${test.name}: ${test.status}${test.summary === undefined ? '' : ` — ${test.summary}`}`,
    ),
  );

  const rendered = lines.join('\n').trimEnd();
  return estimateTokens(rendered) <= tokenBudget
    ? rendered
    : truncateToTokens(rendered, tokenBudget);
}
