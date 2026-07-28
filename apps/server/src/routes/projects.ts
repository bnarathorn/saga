import {
  archiveProjectRequestSchema,
  createProjectRequestSchema,
  listProjectsQuerySchema,
  projectRefParamsSchema,
  updateProjectRequestSchema,
  type ProjectSummaryDto,
} from '@saga/contracts';
import type { ProjectWithAliases } from '@saga/core';
import { clampPageSize } from '@saga/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../composition.js';
import { presentProject } from '../lib/presenters.js';
import { resolveAccessibleProject } from '../lib/project-access.js';
import { parseOrThrow } from '../lib/validation.js';
import { withIdempotency } from '../plugins/idempotency.js';

/**
 * Per-project counters are contributed by the domains that own them, so this module never
 * queries `lore.*`, `quest.*` or `party.*` directly (ADR-0001).
 */
export interface ProjectStatsContributors {
  lore?: (
    projectIds: readonly string[],
  ) => Promise<Map<string, { entries: number; stale: number }>>;
  quest?: (
    projectIds: readonly string[],
  ) => Promise<Map<string, { open: number; blocked: number; lastActivityAt: Date | null }>>;
  party?: (projectIds: readonly string[]) => Promise<Map<string, { activeAgents: number }>>;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  contributors: ProjectStatsContributors,
): void {
  const { projects, audit } = ctx.services;

  const summarize = async (rows: readonly ProjectWithAliases[]): Promise<ProjectSummaryDto[]> => {
    const ids = rows.map((row) => row.id);
    const [lore, quest, party, failedJobs] = await Promise.all([
      contributors.lore?.(ids) ?? Promise.resolve(new Map()),
      contributors.quest?.(ids) ?? Promise.resolve(new Map()),
      contributors.party?.(ids) ?? Promise.resolve(new Map()),
      ctx.repositories.jobs.countFailedByProject(ctx.pool, ids),
    ]);

    return rows.map((row) => {
      const loreStats = lore.get(row.id) ?? { entries: 0, stale: 0 };
      const questStats = quest.get(row.id) ?? { open: 0, blocked: 0, lastActivityAt: null };
      const partyStats = party.get(row.id) ?? { activeAgents: 0 };
      return {
        ...presentProject(row),
        stats: {
          lore_entry_count: loreStats.entries,
          stale_lore_count: loreStats.stale,
          open_quest_count: questStats.open,
          blocked_quest_count: questStats.blocked,
          active_agent_count: partyStats.activeAgents,
          failed_job_count: failedJobs.get(row.id) ?? 0,
          last_activity_at:
            questStats.lastActivityAt === null
              ? row.updatedAt.toISOString()
              : questStats.lastActivityAt.toISOString(),
        },
        // A project with no active context snapshot has never had Lore published.
        bootstrap_required: row.activeContextSnapshotId === null,
      };
    });
  };

  app.get('/api/projects', async (request) => {
    request.requirePermission('project:read');
    const query = parseOrThrow(listProjectsQuerySchema, request.query, 'query');
    const page = await projects.list({
      status: query.status,
      search: query.q,
      cursor: query.cursor,
      limit: clampPageSize(query.limit),
    });

    // An agent token may only ever see its own project.
    const actor = request.actor;
    const visible =
      actor.type === 'agent'
        ? page.items.filter((item) => item.id === actor.projectId)
        : page.items;

    return {
      items: await summarize(visible),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    };
  });

  app.post('/api/projects', async (request, reply) => {
    request.requirePermission('project:write');
    const body = parseOrThrow(createProjectRequestSchema, request.body);

    return withIdempotency(
      {
        pool: ctx.pool,
        records: ctx.repositories.idempotency,
        retentionHours: ctx.config.retention.idempotencyHours,
      },
      request,
      reply,
      'project.create',
      async () => {
        const project = await projects.create({
          name: body.name,
          description: body.description ?? null,
          loreApprovalMode: body.lore_approval_mode,
          correlationId: request.id,
        });
        await audit.record({
          actorType: request.actor.type === 'user' ? 'user' : 'agent',
          actorId: request.actor.type === 'user' ? request.actor.userId : null,
          actorLabel: request.actorLabel,
          action: 'project.created',
          projectId: project.id,
          entityType: 'project',
          entityId: project.id,
          requestId: request.id,
          metadata: { name: project.name },
        });
        return {
          status: 201,
          body: { project: presentProject(project) },
          resourceId: project.id,
        };
      },
    );
  });

  app.get('/api/projects/:projectRef', async (request) => {
    request.requirePermission('project:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);
    const withAliases = await projects.withAliases(project);
    const [summary] = await summarize([withAliases]);
    return { project: summary };
  });

  app.patch('/api/projects/:projectRef', async (request) => {
    request.requirePermission('project:write');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(updateProjectRequestSchema, request.body);

    const before = await projects.resolve(params.projectRef);
    const project = await projects.update(params.projectRef, {
      name: body.name,
      description: body.description,
      loreApprovalMode: body.lore_approval_mode,
      correlationId: request.id,
    });

    if (body.name !== undefined && project.name !== before.name) {
      await audit.record({
        actorType: request.actor.type === 'user' ? 'user' : 'agent',
        actorId: request.actor.type === 'user' ? request.actor.userId : null,
        actorLabel: request.actorLabel,
        action: 'project.renamed',
        projectId: project.id,
        entityType: 'project',
        entityId: project.id,
        requestId: request.id,
        metadata: { from: before.name, to: project.name },
      });
    }

    return { project: presentProject(project) };
  });

  app.post('/api/projects/:projectRef/archive', async (request) => {
    request.requirePermission('project:archive');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(archiveProjectRequestSchema, request.body ?? {});
    const project = await projects.archive(params.projectRef, body.reason, request.id);
    await audit.record({
      actorType: 'user',
      actorId: request.actor.type === 'user' ? request.actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'project.archived',
      projectId: project.id,
      entityType: 'project',
      entityId: project.id,
      reason: body.reason,
      requestId: request.id,
    });
    return { project: presentProject(project) };
  });

  app.post('/api/projects/:projectRef/restore', async (request) => {
    request.requirePermission('project:archive');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(archiveProjectRequestSchema, request.body ?? {});
    const project = await projects.restore(params.projectRef, body.reason, request.id);
    await audit.record({
      actorType: 'user',
      actorId: request.actor.type === 'user' ? request.actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'project.restored',
      projectId: project.id,
      entityType: 'project',
      entityId: project.id,
      reason: body.reason,
      requestId: request.id,
    });
    return { project: presentProject(project) };
  });
}
