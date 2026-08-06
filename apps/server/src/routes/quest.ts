import {
  activateSessionRequestSchema,
  createCheckpointRequestSchema,
  createDependencyRequestSchema,
  createQuestRequestSchema,
  endSessionRequestSchema,
  listQuestsQuerySchema,
  projectRefParamsSchema,
  promoteSessionRequestSchema,
  reasonRequestSchema,
  startSessionRequestSchema,
  updateQuestRequestSchema,
  type StartSessionResponse,
} from '@saga/contracts';
import { bootstrapPlan } from '@saga/lore';
import { SagaError, clampPageSize } from '@saga/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../composition.js';
import {
  presentCheckpoint,
  presentDependency,
  presentQuest,
  presentSession,
} from '../lib/quest-presenters.js';
import { resolveAccessibleProject, resolveWritableProject } from '../lib/project-access.js';
import { parseOrThrow } from '../lib/validation.js';
import { withIdempotency } from '../plugins/idempotency.js';

export function registerQuestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const quests = ctx.services.quests;
  const sessions = ctx.services.sessions;

  const idempotency = {
    pool: ctx.pool,
    records: ctx.repositories.idempotency,
    retentionHours: ctx.config.retention.idempotencyHours,
  };

  /** An agent token may only reach Quests inside its own project. */
  const assertQuestVisible = async (
    request: { actor: { type: string; projectId?: string } },
    projectId: string,
  ): Promise<void> => {
    const actor = request.actor;
    if (actor.type === 'agent' && actor.projectId !== projectId) {
      throw new SagaError('QUEST_NOT_FOUND', 'No Quest matches that id.');
    }
  };

  // --- quests --------------------------------------------------------------

  app.get('/api/projects/:projectRef/quests', async (request) => {
    request.requirePermission('quest:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const query = parseOrThrow(listQuestsQuerySchema, request.query, 'query');
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);

    const page = await quests.list({
      projectId: project.id,
      status: query.status,
      priority: query.priority,
      parentWorkItemId: query.parent_work_item_id,
      includeArchived: query.include_archived,
      search: query.q,
      cursor: query.cursor,
      limit: clampPageSize(query.limit),
    });

    return {
      items: page.items.map(presentQuest),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    };
  });

  app.post('/api/projects/:projectRef/quests', async (request, reply) => {
    request.requirePermission('quest:write');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(createQuestRequestSchema, request.body);
    const project = await resolveWritableProject(ctx, request, params.projectRef);

    return withIdempotency(idempotency, request, reply, 'quest.create', async () => {
      const quest = await quests.create({
        project,
        title: body.title,
        objective: body.objective ?? null,
        priority: body.priority,
        scope: body.scope,
        parentWorkItemId: body.parent_work_item_id ?? null,
        sessionId: body.session_id ?? null,
        correlationId: request.id,
      });
      return { status: 201, body: { quest: presentQuest(quest) }, resourceId: quest.id };
    });
  });

  app.get('/api/quests/:questId', async (request) => {
    request.requirePermission('quest:read');
    const { questId } = request.params as { questId: string };
    const quest = await quests.get(questId);
    await assertQuestVisible(request, quest.projectId);

    const [children, dependencies, checkpoints, questSessions] = await Promise.all([
      quests.listChildren(questId),
      quests.listDependencies(questId),
      quests.listCheckpoints(questId, 20),
      quests.listSessions(questId),
    ]);

    return {
      quest: presentQuest(quest),
      children: children.map(presentQuest),
      dependencies: dependencies.map(presentDependency),
      checkpoints: checkpoints.map(presentCheckpoint),
      sessions: questSessions.map(presentSession),
      latest_handoff:
        checkpoints.find((checkpoint) => checkpoint.kind === 'final_handoff') === undefined
          ? null
          : presentCheckpoint(checkpoints.find((c) => c.kind === 'final_handoff')!),
    };
  });

  app.patch('/api/quests/:questId', async (request) => {
    request.requirePermission('quest:write');
    const { questId } = request.params as { questId: string };
    const body = parseOrThrow(updateQuestRequestSchema, request.body);
    const existing = await quests.get(questId);
    await assertQuestVisible(request, existing.projectId);

    const quest = await quests.update(
      questId,
      {
        title: body.title,
        objective: body.objective,
        status: body.status,
        priority: body.priority,
        scope: body.scope,
        parentWorkItemId: body.parent_work_item_id,
      },
      request.id,
    );
    return { quest: presentQuest(quest) };
  });

  app.post('/api/quests/:questId/archive', async (request) => {
    request.requirePermission('quest:write');
    const { questId } = request.params as { questId: string };
    const existing = await quests.get(questId);
    await assertQuestVisible(request, existing.projectId);
    return { quest: presentQuest(await quests.archive(questId)) };
  });

  app.post('/api/quests/:questId/reopen', async (request) => {
    request.requirePermission('quest:write');
    const { questId } = request.params as { questId: string };
    // Reopening is disruptive enough to require a stated reason for the audit log.
    const body = parseOrThrow(reasonRequestSchema, request.body ?? {});
    const existing = await quests.get(questId);
    await assertQuestVisible(request, existing.projectId);

    const quest = await quests.reopen(questId, request.id);
    await ctx.services.audit.record({
      actorType: request.actor.type === 'user' ? 'user' : 'agent',
      actorId: request.actor.type === 'user' ? request.actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'quest.reopened',
      projectId: quest.projectId,
      entityType: 'work_item',
      entityId: quest.id,
      reason: body.reason,
      requestId: request.id,
    });
    return { quest: presentQuest(quest) };
  });

  app.post('/api/quests/:questId/dependencies', async (request, reply) => {
    request.requirePermission('quest:write');
    const { questId } = request.params as { questId: string };
    const body = parseOrThrow(createDependencyRequestSchema, request.body);
    const existing = await quests.get(questId);
    await assertQuestVisible(request, existing.projectId);

    const dependencies = await quests.addDependency(
      questId,
      body.depends_on_work_item_id,
      body.dependency_type,
    );
    void reply.status(201);
    return { dependencies: dependencies.map(presentDependency) };
  });

  app.delete('/api/quests/:questId/dependencies/:dependsOnId', async (request) => {
    request.requirePermission('quest:write');
    const { questId, dependsOnId } = request.params as { questId: string; dependsOnId: string };
    const existing = await quests.get(questId);
    await assertQuestVisible(request, existing.projectId);
    await quests.removeDependency(questId, dependsOnId);
    return { ok: true as const };
  });

  app.get('/api/quests/:questId/checkpoints', async (request) => {
    request.requirePermission('quest:read');
    const { questId } = request.params as { questId: string };
    const quest = await quests.get(questId);
    await assertQuestVisible(request, quest.projectId);
    const checkpoints = await quests.listCheckpoints(questId, 100);
    return { items: checkpoints.map(presentCheckpoint), quest_revision: quest.revision };
  });

  app.get('/api/quests/:questId/sessions', async (request) => {
    request.requirePermission('quest:read');
    const { questId } = request.params as { questId: string };
    const quest = await quests.get(questId);
    await assertQuestVisible(request, quest.projectId);
    return { items: (await quests.listSessions(questId)).map(presentSession) };
  });

  // --- sessions ------------------------------------------------------------

  app.post('/api/sessions', async (request, reply) => {
    request.requirePermission('quest:write');
    const body = parseOrThrow(startSessionRequestSchema, request.body);
    const project = await resolveAccessibleProject(ctx, request, body.project);

    return withIdempotency(idempotency, request, reply, 'session.start', async () => {
      const result = await sessions.start({
        project,
        client: body.client,
        agent: body.agent ?? null,
        workspaceKey: body.workspace_key ?? null,
        workspaceLabel: body.workspace_label ?? null,
        correlationId: request.id,
      });

      // Phase one deliberately returns *only* short core context. No handoff is loaded here,
      // because Saga does not yet know what the user intends to do (spec 9.1).
      const snapshot = await ctx.services.lore.activeSnapshot(project.id);
      const bootstrapRequired = snapshot === null;

      const payload: StartSessionResponse = {
        session_id: result.session.id,
        state: result.session.state,
        project: { id: project.id, name: project.name },
        project_revision: project.memoryRevision,
        core_context: snapshot?.renderedContext ?? '',
        bootstrap_required: bootstrapRequired,
        bootstrap_plan: bootstrapRequired ? bootstrapPlan(true) : null,
        open_quests: result.openQuests.map((quest) => ({
          id: quest.id,
          title: quest.title,
          status: quest.status,
          last_activity_at: quest.lastActivityAt.toISOString(),
        })),
        agent_run_id: result.agentRunId,
      };

      return { status: 201, body: payload, resourceId: result.session.id };
    });
  });

  app.get('/api/sessions/:sessionId', async (request) => {
    request.requirePermission('quest:read');
    const { sessionId } = request.params as { sessionId: string };
    const session = await sessions.get(sessionId);
    await assertQuestVisible(request, session.projectId);
    return { session: presentSession(session) };
  });

  app.post('/api/sessions/:sessionId/activate', async (request) => {
    request.requirePermission('quest:write');
    const { sessionId } = request.params as { sessionId: string };
    const body = parseOrThrow(activateSessionRequestSchema, request.body);

    const session = await sessions.get(sessionId);
    await assertQuestVisible(request, session.projectId);
    const project = await resolveWritableProject(ctx, request, session.projectId);

    const result = await sessions.activate({
      sessionId,
      project,
      task: body.task,
      modeHint: body.mode_hint,
      requestedQuestId: body.requested_quest_id ?? null,
      scope: body.scope,
      correlationId: request.id,
    });

    // The matching explanation goes to the logs, not to the response: it can quote task text.
    request.log.info(
      {
        session_id: sessionId,
        project_id: project.id,
        quest_id: result.quest?.id,
        operation: 'session.activate',
        activation_mode: result.mode,
        match_explanation: result.explanation,
      },
      'session activated',
    );

    const context = await ctx.services.context.compose(project, {
      task: body.task,
      mode: result.mode,
      quest_id: result.quest?.id,
      session_id: sessionId,
      token_budget: body.token_budget,
    });

    return {
      activation_mode: result.mode,
      quest: result.quest === null ? null : presentQuest(result.quest),
      context: {
        core: context.core_context,
        task: context.task_context,
        continuation: context.continuation,
        party: context.party,
        warnings: context.warnings,
      },
      related_quests: result.related,
    };
  });

  app.post('/api/sessions/:sessionId/promote', async (request) => {
    request.requirePermission('quest:write');
    const { sessionId } = request.params as { sessionId: string };
    const body = parseOrThrow(promoteSessionRequestSchema, request.body);

    const session = await sessions.get(sessionId);
    await assertQuestVisible(request, session.projectId);
    const project = await resolveWritableProject(ctx, request, session.projectId);

    const result = await sessions.promote({
      sessionId,
      project,
      mode: body.mode,
      task: body.task,
      requestedQuestId: body.requested_quest_id ?? null,
      scope: body.scope,
      correlationId: request.id,
    });

    const context = await ctx.services.context.compose(project, {
      task: body.task ?? session.initialTask ?? undefined,
      mode: result.mode,
      quest_id: result.quest?.id,
      session_id: sessionId,
    });

    return {
      activation_mode: result.mode,
      quest: result.quest === null ? null : presentQuest(result.quest),
      context: {
        core: context.core_context,
        task: context.task_context,
        continuation: context.continuation,
        party: context.party,
        warnings: context.warnings,
      },
      related_quests: result.related,
    };
  });

  app.post('/api/sessions/:sessionId/checkpoints', async (request, reply) => {
    request.requirePermission('quest:write');
    const { sessionId } = request.params as { sessionId: string };
    const body = parseOrThrow(createCheckpointRequestSchema, request.body);

    const session = await sessions.get(sessionId);
    await assertQuestVisible(request, session.projectId);

    return withIdempotency(idempotency, request, reply, 'checkpoint.create', async () => {
      const result = await quests.createCheckpoint({
        sessionId,
        expectedQuestRevision: body.expected_quest_revision,
        kind: body.kind,
        summary: body.summary,
        workState: body.work_state,
        correlationId: request.id,
      });
      return {
        status: 201,
        body: {
          checkpoint: presentCheckpoint(result.checkpoint),
          quest_revision: result.questRevision,
        },
        resourceId: result.checkpoint.id,
      };
    });
  });

  app.post('/api/sessions/:sessionId/end', async (request) => {
    request.requirePermission('quest:write');
    const { sessionId } = request.params as { sessionId: string };
    const body = parseOrThrow(endSessionRequestSchema, request.body ?? {});

    const session = await sessions.get(sessionId);
    await assertQuestVisible(request, session.projectId);

    const result = await sessions.end({
      sessionId,
      handoff:
        body.handoff === undefined
          ? undefined
          : {
              expectedQuestRevision: body.handoff.expected_quest_revision,
              summary: body.handoff.summary,
              workState: body.handoff.work_state,
            },
      questStatus: body.quest_status,
      correlationId: request.id,
    });

    return {
      session: presentSession(result.session),
      handoff: result.handoff === null ? null : presentCheckpoint(result.handoff),
      quest_revision: result.questRevision,
      released_claims: result.releasedClaims,
      quest_status: result.questStatus,
      quest_status_held: result.questStatusHeld,
    };
  });

  app.post('/api/sessions/:sessionId/heartbeat', async (request) => {
    // Durable session liveness. Party heartbeats (agent runs, claims) are separate.
    request.requirePermission('quest:write');
    const { sessionId } = request.params as { sessionId: string };
    const session = await sessions.get(sessionId);
    await assertQuestVisible(request, session.projectId);
    await sessions.touch(sessionId);
    return { ok: true as const };
  });
}
