import type {
  ActivationMode,
  ModeHint,
  QuestPlanDto,
  QuestScope,
  QuestStatus,
  RelatedQuestDto,
  StepUpdate,
  WorkState,
} from '@saga/contracts';
import type { OutboxRepository, Project, ProjectRepository } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import { SagaError, isSagaError } from '@saga/shared';

/**
 * Statuses an agent cannot walk back from. `completed` and `cancelled` sit outside `RESUMABLE`
 * in `domain/activation.ts`, and no MCP tool reaches the reopen endpoint, so declaring one is
 * the only irreversible thing the end-of-session surface can do — hence the mode gate.
 */
const TERMINAL_QUEST_STATUSES: readonly QuestStatus[] = ['completed', 'cancelled'];
import { classifyActivation, deriveQuestTitle, type QuestCandidate } from '../domain/activation.js';
import type { Checkpoint, Quest, QuestSession } from '../repositories/quest-repository.js';
import { type QuestRepository } from '../repositories/quest-repository.js';
import type { QuestService } from './quest-service.js';

/**
 * Hooks the application registers so Quest can start and stop live coordination without
 * importing Party (which sits above it in the dependency order).
 */
export interface PartyHooks {
  startAgentRun?(input: {
    projectId: string;
    sessionId: string;
    client: string;
    /** Name the host reported at `initialize`, e.g. `claude-code`. Null when it reported none. */
    agent: string | null;
    workspaceKey: string | null;
    workspaceLabel: string | null;
  }): Promise<{ agentRunId: string } | null>;
  attachQuest?(input: { sessionId: string; workItemId: string }): Promise<void>;
  endAgentRun?(input: { sessionId: string }): Promise<{ releasedClaims: number }>;
}

export interface SessionServiceDeps {
  pool: SagaPool;
  quests: QuestRepository;
  questService: QuestService;
  projects: ProjectRepository;
  outbox: OutboxRepository;
  party: PartyHooks;
  /** Sessions quiet for longer than this are marked abandoned by the reaper. */
  abandonAfterMinutes: number;
}

export interface StartSessionResult {
  session: QuestSession;
  project: Project;
  openQuests: Quest[];
  agentRunId: string | null;
}

export interface ActivationResult {
  session: QuestSession;
  mode: ActivationMode;
  quest: Quest | null;
  related: RelatedQuestDto[];
  explanation: string;
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  /**
   * Phase one of session startup (spec 9.1).
   *
   * The session opens in `awaiting_task` with **no Quest attached**. This is the mechanism
   * that stops an unrelated handoff from contaminating a new task: there is nothing to load
   * yet, because Saga does not know what the user is about to do.
   */
  async start(input: {
    project: Project;
    client: string;
    agent?: string | null;
    workspaceKey?: string | null;
    workspaceLabel?: string | null;
    correlationId?: string | null;
  }): Promise<StartSessionResult> {
    const session = await withTransaction(this.deps.pool, async (tx) => {
      const created = await this.deps.quests.createSession(tx, {
        projectId: input.project.id,
        client: input.client,
        agent: input.agent ?? null,
        startedMemoryRevision: input.project.memoryRevision,
        workspaceKey: input.workspaceKey ?? null,
        workspaceLabel: input.workspaceLabel ?? null,
      });

      await this.deps.outbox.emit(tx, {
        aggregateType: 'session',
        aggregateId: created.id,
        topic: 'quest.session_started',
        payload: { client: input.client, agent: input.agent ?? null },
        correlationId: input.correlationId ?? null,
        projectId: input.project.id,
      });

      return created;
    });

    // Open Quests are returned as *suggestions* only; none is attached.
    const openQuests = await this.deps.quests.listResumable(this.deps.pool, input.project.id, 10);

    const run = await this.deps.party.startAgentRun?.({
      projectId: input.project.id,
      sessionId: session.id,
      client: input.client,
      agent: input.agent ?? null,
      workspaceKey: input.workspaceKey ?? null,
      workspaceLabel: input.workspaceLabel ?? null,
    });

    return { session, project: input.project, openQuests, agentRunId: run?.agentRunId ?? null };
  }

  async get(sessionId: string): Promise<QuestSession> {
    const session = await this.deps.quests.findSessionById(this.deps.pool, sessionId);
    if (session === null) {
      throw new SagaError('SESSION_NOT_FOUND', 'No session matches that id.', {
        details: { session_id: sessionId },
      });
    }
    return session;
  }

  /**
   * Phase two: the first user task decides the mode.
   *
   * `new_work` creates a Quest; `resume_work` attaches an existing one; `inquiry` attaches
   * nothing at all and creates no Quest until the session is promoted.
   */
  async activate(input: {
    sessionId: string;
    project: Project;
    task: string;
    modeHint?: ModeHint;
    requestedQuestId?: string | null;
    scope?: QuestScope;
    /** Sub-tasks declared up front. Applied only to a Quest this activation creates. */
    plan?: readonly string[];
    similarity?: Map<string, number>;
    correlationId?: string | null;
  }): Promise<ActivationResult> {
    const session = await this.get(input.sessionId);
    if (session.state === 'completed' || session.state === 'abandoned') {
      throw new SagaError(
        'SESSION_STATE_INVALID',
        `A ${session.state} session cannot be activated. Start a new session.`,
        { details: { state: session.state } },
      );
    }
    // Activation is once per *open* Quest (spec 9.1: open -> await task -> activate). Rebinding
    // a session whose Quest is still live would abandon work in flight, or silently move its
    // later checkpoints onto a different Quest. `promote` guards the same shape.
    //
    // A closed Quest is the exception, and it is the common case now that a finished plan
    // completes a Quest mid-session: the user's next request arrives in the same session, with
    // the Quest it would have attached to already `completed`. Refusing there would strand the
    // agent — nothing in the MCP surface can open a second session — so the work would land as
    // checkpoints on a Quest that is finished, or nowhere at all. Re-activating classifies the
    // new task from scratch, which for a genuinely new request means a new Quest.
    if (session.workItemId !== null) {
      const attached = await this.deps.quests.findById(this.deps.pool, session.workItemId);
      if (attached !== null && !TERMINAL_QUEST_STATUSES.includes(attached.status)) {
        throw new SagaError(
          'SESSION_STATE_INVALID',
          `This session is already attached to a Quest that is still ${attached.status}. Finish or close it before starting different work, or promote an inquiry.`,
          {
            details: {
              work_item_id: session.workItemId,
              quest_status: attached.status,
              state: session.state,
            },
          },
        );
      }
    }
    if (session.projectId !== input.project.id) {
      throw new SagaError('SESSION_NOT_FOUND', 'That session belongs to another project.');
    }

    const candidates = await this.loadCandidates(input.project.id, input.similarity);
    const decision = classifyActivation({
      task: input.task,
      modeHint: input.modeHint ?? 'auto',
      requestedQuestId: input.requestedQuestId ?? null,
      declaredScope: input.scope,
      candidates,
      now: new Date(),
    });

    const related: RelatedQuestDto[] = decision.related.map((entry) => ({
      id: entry.quest.id,
      title: entry.quest.title,
      status: entry.quest.status,
      confidence: entry.confidence,
      reasons: entry.reasons,
      last_activity_at: entry.quest.lastActivityAt.toISOString(),
    }));

    if (decision.mode === 'inquiry') {
      const activated = await withTransaction(this.deps.pool, (tx) =>
        this.deps.quests.activateSession(tx, input.sessionId, {
          workItemId: null,
          activationMode: 'inquiry',
          initialTask: input.task,
        }),
      );
      return {
        session: activated,
        mode: 'inquiry',
        quest: null,
        related,
        explanation: decision.explanation,
      };
    }

    let quest: Quest;
    if (decision.mode === 'resume_work' && decision.matched !== null) {
      const existing = await this.deps.quests.findById(this.deps.pool, decision.matched.id);
      if (existing === null) throw new SagaError('QUEST_NOT_FOUND', 'The Quest no longer exists.');
      quest = existing;
      if (input.scope !== undefined) {
        // Merge newly declared scope into the Quest so Party can see it.
        quest = await this.deps.questService.update(
          quest.id,
          { scope: mergeScope(quest.scope, input.scope) },
          input.correlationId,
        );
      }
    } else {
      quest = await this.deps.questService.create({
        project: input.project,
        title: deriveQuestTitle(input.task),
        objective: input.task,
        scope: input.scope ?? {},
        sessionId: input.sessionId,
        correlationId: input.correlationId,
      });
      // Only for a Quest this activation created. A resumed Quest already has whatever plan its
      // earlier sessions declared, and silently replacing it from a `mode_hint: auto` guess
      // would discard steps another session recorded as done.
      if (input.plan !== undefined && input.plan.length > 0) {
        await this.deps.questService.setPlan(quest.id, input.plan, input.correlationId);
      }
    }

    const activated = await withTransaction(this.deps.pool, async (tx) => {
      const updated = await this.deps.quests.activateSession(tx, input.sessionId, {
        workItemId: quest.id,
        activationMode: decision.mode,
        initialTask: input.task,
      });
      // Starting work on a Quest moves it out of `open` unless a human set the status.
      const locked = await this.deps.quests.lockById(tx, quest.id);
      if (locked !== null && locked.status === 'open' && !locked.statusSetManually) {
        await this.deps.quests.update(tx, quest.id, { status: 'in_progress' });
      } else {
        await this.deps.quests.touch(tx, quest.id);
      }
      return updated;
    });

    await this.deps.party.attachQuest?.({ sessionId: input.sessionId, workItemId: quest.id });

    const refreshed = await this.deps.quests.findById(this.deps.pool, quest.id);
    return {
      session: activated,
      mode: decision.mode,
      quest: refreshed ?? quest,
      related,
      explanation: decision.explanation,
    };
  }

  /**
   * Promote an inquiry session to real work once it starts changing files (spec 9.4).
   */
  async promote(input: {
    sessionId: string;
    project: Project;
    mode: 'new_work' | 'resume_work';
    task?: string;
    requestedQuestId?: string | null;
    scope?: QuestScope;
    correlationId?: string | null;
  }): Promise<ActivationResult> {
    const session = await this.get(input.sessionId);
    if (session.workItemId !== null) {
      throw new SagaError(
        'SESSION_STATE_INVALID',
        'This session already has a Quest; there is nothing to promote.',
        { details: { work_item_id: session.workItemId } },
      );
    }
    if (session.state === 'completed' || session.state === 'abandoned') {
      throw new SagaError(
        'SESSION_STATE_INVALID',
        `A ${session.state} session cannot be promoted.`,
      );
    }

    return this.activate({
      sessionId: input.sessionId,
      project: input.project,
      task: input.task ?? session.initialTask ?? 'Continue the current work',
      modeHint: input.mode,
      requestedQuestId: input.requestedQuestId ?? null,
      scope: input.scope,
      correlationId: input.correlationId,
    });
  }

  /**
   * Clean session end (spec 9.8).
   *
   * Durable checkpoint creation takes priority: if ending the Agent Run fails, the handoff is
   * already committed and leases will clean up the live state.
   */
  async end(input: {
    sessionId: string;
    handoff?: {
      expectedQuestRevision: number;
      summary: string;
      workState: WorkState;
      stepUpdates?: readonly StepUpdate[];
    };
    /** What the agent declares has become of the Quest. Never inferred from the work state. */
    questStatus?: QuestStatus;
    correlationId?: string | null;
  }): Promise<{
    session: QuestSession;
    handoff: Checkpoint | null;
    questRevision: number | null;
    releasedClaims: number;
    questStatus: QuestStatus | null;
    questStatusHeld: string | null;
    plan: QuestPlanDto | null;
  }> {
    const session = await this.get(input.sessionId);
    if (session.state === 'completed') {
      return {
        session,
        handoff: null,
        questRevision: null,
        releasedClaims: 0,
        questStatus: null,
        questStatusHeld: null,
        plan: null,
      };
    }

    let handoff: Checkpoint | null = null;
    let questRevision: number | null = null;
    let plan: QuestPlanDto | null = null;
    // Why a finished plan did not close the Quest, when that is what happened. Kept separate
    // from the declared-status outcome so a declaration that changed nothing does not erase it.
    let planHeld: string | null = null;

    if (session.workItemId !== null) {
      if (input.handoff === undefined) {
        throw new SagaError(
          'CHECKPOINT_INVALID',
          'A session that owns a Quest must record a final handoff before it ends. Only an inquiry session with no Quest may end without one.',
          { details: { work_item_id: session.workItemId } },
        );
      }
      const created = await this.deps.questService.createCheckpoint({
        sessionId: input.sessionId,
        expectedQuestRevision: input.handoff.expectedQuestRevision,
        kind: 'final_handoff',
        summary: input.handoff.summary,
        workState: input.handoff.workState,
        stepUpdates: input.handoff.stepUpdates,
        correlationId: input.correlationId,
      });
      handoff = created.checkpoint;
      questRevision = created.questRevision;
      plan = created.plan;
      planHeld = created.questStatusHeld;
    }

    const outcome = await this.applyDeclaredQuestStatus({
      workItemId: session.workItemId,
      projectId: session.projectId,
      sessionId: input.sessionId,
      declared: input.questStatus,
      correlationId: input.correlationId ?? null,
    });

    const ended = await withTransaction(this.deps.pool, async (tx) => {
      const updated = await this.deps.quests.endSession(tx, input.sessionId, 'completed');
      await this.deps.outbox.emit(tx, {
        aggregateType: 'session',
        aggregateId: input.sessionId,
        topic: 'quest.session_ended',
        payload: {
          client: session.client,
          work_item_id: session.workItemId,
          handoff_id: handoff?.id ?? null,
        },
        correlationId: input.correlationId ?? null,
        projectId: session.projectId,
      });
      return updated;
    });

    let releasedClaims = 0;
    try {
      const result = await this.deps.party.endAgentRun?.({ sessionId: input.sessionId });
      releasedClaims = result?.releasedClaims ?? 0;
    } catch {
      // The durable record is already committed; live coordination state expires by lease.
      releasedClaims = 0;
    }

    return {
      session: ended,
      handoff,
      questRevision,
      releasedClaims,
      questStatus: outcome.status,
      // A finished plan that was held back is the more useful answer of the two: the agent asked
      // for nothing and still needs telling why the Quest it finished is still open.
      questStatusHeld: outcome.held ?? planHeld,
      plan,
    };
  }

  /**
   * Act on the status the agent declared for its Quest, or say why it was not acted on.
   *
   * Two gates, and both exist because completion is one-way from the agent's side: `completed`
   * and `cancelled` are outside `RESUMABLE` (`domain/activation.ts`), a named-but-completed
   * Quest falls through to `new_work` rather than resuming, and no MCP tool reaches
   * `POST /api/quests/:questId/reopen`. A wrong close silently forks the work.
   *
   *   1. The project's `quest_completion_mode` must be `auto` for a terminal status. On
   *      `manual` the declaration still reaches the handoff, and a person closes the Quest.
   *   2. No other session may still be attached to the Quest. Quest-to-session is one-to-many
   *      — `resume_work` and `requested_quest_id` both re-attach — so one agent finishing is
   *      not the same as the work being finished.
   *
   * A non-terminal status (`blocked`, `waiting`) is applied either way: it neither ends the
   * Quest nor takes it out of the resumable set, so there is nothing to guard against.
   */
  private async applyDeclaredQuestStatus(input: {
    workItemId: string | null;
    projectId: string;
    sessionId: string;
    declared: QuestStatus | undefined;
    correlationId: string | null;
  }): Promise<{ status: QuestStatus | null; held: string | null }> {
    if (input.workItemId === null) return { status: null, held: null };

    const current = await this.deps.quests.findById(this.deps.pool, input.workItemId);
    if (current === null) return { status: null, held: null };
    // A session that owned a Quest reports where it left it, declaration or not, so the caller
    // never has to guess whether silence meant "unchanged" or "no Quest".
    if (input.declared === undefined) return { status: current.status, held: null };
    if (current.status === input.declared) return { status: current.status, held: null };

    if (TERMINAL_QUEST_STATUSES.includes(input.declared)) {
      const project = await this.deps.projects.findById(this.deps.pool, input.projectId);
      if (project?.questCompletionMode !== 'auto') {
        return {
          status: current.status,
          held: `The project is on quest_completion_mode "manual", so "${input.declared}" was recorded in the handoff and the Quest was left open for Guild Hall.`,
        };
      }

      const others = await this.deps.quests.listSessionsForQuest(this.deps.pool, input.workItemId);
      const stillOpen = others.filter(
        (other) =>
          other.id !== input.sessionId &&
          (other.state === 'active' || other.state === 'awaiting_task'),
      );
      if (stillOpen.length > 0) {
        return {
          status: current.status,
          held: `${stillOpen.length} other session(s) are still attached to this Quest, so it was left open.`,
        };
      }
    }

    try {
      const updated = await this.deps.questService.update(
        input.workItemId,
        { status: input.declared },
        input.correlationId,
      );
      return { status: updated.status, held: null };
    } catch (error) {
      // A status declaration must never cost the agent its handoff. The checkpoint is already
      // committed and the session still has to end; an illegal transition — someone closed the
      // Quest in Guild Hall mid-session, say — is reported, not thrown.
      if (isSagaError(error) && error.code === 'QUEST_STATE_INVALID') {
        return { status: current.status, held: error.message };
      }
      throw error;
    }
  }

  /** Mark sessions abandoned once they stop reporting. Called by the worker. */
  async reapStaleSessions(now = new Date(), limit = 100): Promise<string[]> {
    const cutoff = new Date(now.getTime() - this.deps.abandonAfterMinutes * 60_000);
    const stale = await this.deps.quests.findStaleSessions(this.deps.pool, cutoff, limit);
    if (stale.length === 0) return [];

    return withTransaction(this.deps.pool, async (tx) => {
      const abandoned: string[] = [];
      for (const session of stale) {
        // Re-checked against the cutoff at write time: the candidate list was read outside this
        // transaction, and a session that reported in since then must be left alone.
        const ended = await this.deps.quests.abandonIfStale(tx, session.id, cutoff);
        if (ended === null) continue;
        await this.deps.outbox.emit(tx, {
          aggregateType: 'session',
          aggregateId: session.id,
          topic: 'quest.session_abandoned',
          payload: {
            client: session.client,
            work_item_id: session.workItemId,
            last_seen_at: session.lastSeenAt?.toISOString() ?? null,
          },
          projectId: session.projectId,
        });
        abandoned.push(session.id);
      }
      return abandoned;
    });
  }

  async touch(sessionId: string): Promise<void> {
    await this.deps.quests.touchSession(this.deps.pool, sessionId);
  }

  private async loadCandidates(
    projectId: string,
    similarity: Map<string, number> | undefined,
  ): Promise<QuestCandidate[]> {
    const quests = await this.deps.quests.listResumable(this.deps.pool, projectId, 50);
    return quests.map((quest) => ({
      id: quest.id,
      title: quest.title,
      objective: quest.objective,
      status: quest.status,
      scope: quest.scope,
      lastActivityAt: quest.lastActivityAt,
      similarity: similarity?.get(quest.id),
    }));
  }
}

/** Union the arrays of two scopes without duplicating entries. */
export function mergeScope(base: QuestScope, addition: QuestScope): QuestScope {
  const merged: QuestScope = { ...base };
  const fields: (keyof QuestScope)[] = [
    'modules',
    'components',
    'apis',
    'databases',
    'files',
    'issue_keys',
  ];
  for (const field of fields) {
    const combined = [...(base[field] ?? []), ...(addition[field] ?? [])];
    if (combined.length > 0) merged[field] = [...new Set(combined)];
  }
  return merged;
}
