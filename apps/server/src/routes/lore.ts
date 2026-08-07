import {
  contextRequestSchema,
  createLinkRequestSchema,
  listLinksQuerySchema,
  evidenceCheckRequestSchema,
  listLoreQuerySchema,
  loreSearchRequestSchema,
  markStaleRequestSchema,
  memoryUpdateStateSchema,
  projectRefParamsSchema,
  reasonRequestSchema,
  rememberRequestSchema,
  type EvidenceCheckResponse,
} from '@saga/contracts';
import { SagaError, clampPageSize } from '@saga/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../composition.js';
import {
  presentBootstrapPlan,
  presentLoreEntry,
  presentLoreUpdate,
  presentMemoryLink,
  presentMemoryVersion,
  presentSnapshot,
} from '../lib/lore-presenters.js';
import { resolveAccessibleProject, resolveWritableProject } from '../lib/project-access.js';
import { parseOrThrow } from '../lib/validation.js';
import { withIdempotency } from '../plugins/idempotency.js';

export function registerLoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  const lore = ctx.services.lore;
  const search = ctx.services.loreSearch;
  const context = ctx.services.context;
  const { audit } = ctx.services;

  // --- reads ---------------------------------------------------------------

  app.get('/api/projects/:projectRef/lore', async (request) => {
    request.requirePermission('lore:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const query = parseOrThrow(listLoreQuerySchema, request.query, 'query');
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);

    const page = await lore.listEntries({
      projectId: project.id,
      category: query.category,
      kind: query.kind,
      state: query.state,
      verificationState: query.verification_state,
      volatility: query.volatility,
      minImportance: query.min_importance,
      cursor: query.cursor,
      limit: clampPageSize(query.limit),
    });

    return {
      items: page.items.map(presentLoreEntry),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
      memory_revision: project.memoryRevision,
    };
  });

  app.get('/api/projects/:projectRef/lore/:memoryKey', async (request) => {
    request.requirePermission('lore:read');
    const { projectRef, memoryKey } = request.params as { projectRef: string; memoryKey: string };
    const project = await resolveAccessibleProject(ctx, request, projectRef);
    const entry = await lore.getEntry(project.id, memoryKey);
    const links = await ctx.repositories.links.listForItems(ctx.pool, [entry.id]);
    return { entry: presentLoreEntry(entry), links: links.map(presentMemoryLink) };
  });

  app.get('/api/projects/:projectRef/lore/:memoryKey/versions', async (request) => {
    request.requirePermission('lore:read');
    const { projectRef, memoryKey } = request.params as { projectRef: string; memoryKey: string };
    const project = await resolveAccessibleProject(ctx, request, projectRef);
    const versions = await lore.listVersions(project.id, memoryKey);
    const entry = await lore.getEntry(project.id, memoryKey);
    return {
      items: versions.map(presentMemoryVersion),
      current_version_id: entry.currentVersionId,
    };
  });

  app.post('/api/projects/:projectRef/lore/search', async (request) => {
    request.requirePermission('lore:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(loreSearchRequestSchema, request.body);
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);
    return search.search(project, body);
  });

  // --- proposals -----------------------------------------------------------

  app.post('/api/projects/:projectRef/lore/remember', async (request, reply) => {
    // `remember` never overwrites current Lore: it creates a candidate update.
    request.requirePermission('lore:propose');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(rememberRequestSchema, request.body);
    const project = await resolveWritableProject(ctx, request, params.projectRef);

    return withIdempotency(
      {
        pool: ctx.pool,
        records: ctx.repositories.idempotency,
        retentionHours: ctx.config.retention.idempotencyHours,
      },
      request,
      reply,
      'lore.remember',
      async () => {
        const update = await lore.propose({
          project,
          entries: body.entries,
          summary: body.summary,
          sessionId: body.session_id ?? null,
          correlationId: request.id,
        });
        const detail = await lore.getUpdate(update.id);
        return {
          status: 202,
          body: {
            update: presentLoreUpdate(detail),
            approval_mode: project.loreApprovalMode,
            message:
              project.loreApprovalMode === 'auto'
                ? 'The proposal is queued for validation and will publish automatically.'
                : 'The proposal is queued for validation and will wait for approval in Guild Hall.',
          },
          resourceId: update.id,
        };
      },
    );
  });

  // `lore/updates` is an alias for `remember` with the same semantics, kept because the
  // specification names both spellings.
  app.post('/api/projects/:projectRef/lore/updates', async (request, reply) => {
    request.requirePermission('lore:propose');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(rememberRequestSchema, request.body);
    const project = await resolveWritableProject(ctx, request, params.projectRef);
    const update = await lore.propose({
      project,
      entries: body.entries,
      summary: body.summary,
      sessionId: body.session_id ?? null,
      correlationId: request.id,
    });
    void reply.status(202);
    return { update: presentLoreUpdate(await lore.getUpdate(update.id)) };
  });

  app.get('/api/projects/:projectRef/lore-updates', async (request) => {
    request.requirePermission('lore:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);
    const query = request.query as { state?: string };
    const state =
      query.state === undefined ? undefined : memoryUpdateStateSchema.parse(query.state);
    const updates = await lore.listUpdates(project.id, state);
    const detailed = await Promise.all(updates.map((update) => lore.getUpdate(update.id)));
    return { items: detailed.map(presentLoreUpdate) };
  });

  app.get('/api/lore/updates/:updateId', async (request) => {
    request.requirePermission('lore:read');
    const { updateId } = request.params as { updateId: string };
    const detail = await lore.getUpdate(updateId);
    await assertUpdateVisible(ctx, request, detail.update.projectId);
    return { update: presentLoreUpdate(detail) };
  });

  app.post('/api/lore/updates/:updateId/validate', async (request) => {
    request.requirePermission('lore:propose');
    const { updateId } = request.params as { updateId: string };
    const existing = await lore.getUpdate(updateId);
    await assertUpdateVisible(ctx, request, existing.update.projectId);
    await lore.validate(updateId);
    return { update: presentLoreUpdate(await lore.getUpdate(updateId)) };
  });

  app.post('/api/lore/updates/:updateId/publish', async (request) => {
    request.requirePermission('lore:publish');
    const { updateId } = request.params as { updateId: string };
    const existing = await lore.getUpdate(updateId);
    await assertUpdateVisible(ctx, request, existing.update.projectId);

    const published = await lore.publish(updateId);
    const detail = await lore.getUpdate(updateId);

    await audit.record({
      actorType: request.actor.type === 'user' ? 'user' : 'agent',
      actorId: request.actor.type === 'user' ? request.actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'lore.published',
      projectId: existing.update.projectId,
      entityType: 'memory_update',
      entityId: updateId,
      requestId: request.id,
      metadata: {
        memory_revision: published.memoryRevision,
        memory_keys: detail.items.map((item) => item.memoryKey),
      },
    });

    return { update: presentLoreUpdate(detail), memory_revision: published.memoryRevision };
  });

  app.post('/api/lore/updates/:updateId/cancel', async (request) => {
    request.requirePermission('lore:propose');
    const { updateId } = request.params as { updateId: string };
    const body = parseOrThrow(reasonRequestSchema, request.body ?? {});
    const existing = await lore.getUpdate(updateId);
    await assertUpdateVisible(ctx, request, existing.update.projectId);
    await lore.cancel(updateId, body.reason);
    return { update: presentLoreUpdate(await lore.getUpdate(updateId)) };
  });

  // --- lifecycle -----------------------------------------------------------

  app.post('/api/projects/:projectRef/lore/:memoryKey/mark-stale', async (request) => {
    request.requirePermission('lore:propose');
    const { projectRef, memoryKey } = request.params as { projectRef: string; memoryKey: string };
    const body = parseOrThrow(markStaleRequestSchema, request.body ?? {});
    const project = await resolveWritableProject(ctx, request, projectRef);

    const item = await lore.markStale(project, memoryKey, body.reason);
    // Core context must stop advertising a stale entry, so the snapshot is rebuilt.
    await ctx.services.jobs.enqueue({
      projectId: project.id,
      jobType: 'context_snapshot',
      entityType: 'project',
      entityId: project.id,
      dedupeKey: `snapshot:${project.id}`,
      payload: { project_id: project.id },
      correlationId: request.id,
    });

    await audit.record({
      actorType: request.actor.type === 'user' ? 'user' : 'agent',
      actorId: request.actor.type === 'user' ? request.actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'lore.marked_stale',
      projectId: project.id,
      entityType: 'memory_item',
      entityId: item.id,
      reason: body.reason,
      requestId: request.id,
      metadata: { memory_key: memoryKey },
    });

    return { entry: presentLoreEntry({ ...item, currentVersion: null }) };
  });

  app.post('/api/projects/:projectRef/lore/:memoryKey/archive', async (request) => {
    request.requirePermission('lore:archive');
    const { projectRef, memoryKey } = request.params as { projectRef: string; memoryKey: string };
    const body = parseOrThrow(reasonRequestSchema, request.body ?? {});
    const project = await resolveWritableProject(ctx, request, projectRef);

    const item = await lore.archiveEntry(project, memoryKey, body.reason);
    await ctx.services.jobs.enqueue({
      projectId: project.id,
      jobType: 'context_snapshot',
      entityType: 'project',
      entityId: project.id,
      dedupeKey: `snapshot:${project.id}`,
      payload: { project_id: project.id },
      correlationId: request.id,
    });

    await audit.record({
      actorType: request.actor.type === 'user' ? 'user' : 'agent',
      actorId: request.actor.type === 'user' ? request.actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'lore.archived',
      projectId: project.id,
      entityType: 'memory_item',
      entityId: item.id,
      reason: body.reason,
      requestId: request.id,
      metadata: { memory_key: memoryKey },
    });

    return { entry: presentLoreEntry({ ...item, currentVersion: null }) };
  });

  // --- evidence ------------------------------------------------------------

  app.post('/api/projects/:projectRef/lore/evidence/check', async (request) => {
    // The server never reads the caller's filesystem; the CLI or agent reports observations.
    request.requirePermission('lore:propose');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(evidenceCheckRequestSchema, request.body);
    const project = await resolveWritableProject(ctx, request, params.projectRef);

    const observed = new Map(body.observations.map((entry) => [entry.path, entry.content_hash]));
    const items = await lore.listEntries({ projectId: project.id, state: 'active', limit: 500 });

    const drifted: EvidenceCheckResponse['drifted'] = [];
    const markedStale: string[] = [];

    for (const item of items.items) {
      if (item.currentVersion === null) continue;
      for (const evidence of item.currentVersion.evidence) {
        if (!observed.has(evidence.path)) continue;
        const observedHash = observed.get(evidence.path) ?? null;
        const recordedHash = evidence.content_hash ?? null;

        if (observedHash === null) {
          drifted.push({
            memory_key: item.memoryKey,
            path: evidence.path,
            recorded_hash: recordedHash,
            observed_hash: null,
            reason: 'path_missing',
          });
          await lore.markStale(
            project,
            item.memoryKey,
            `The evidence file "${evidence.path}" no longer exists.`,
          );
          markedStale.push(item.memoryKey);
          break;
        }
        if (recordedHash !== null && recordedHash !== observedHash) {
          drifted.push({
            memory_key: item.memoryKey,
            path: evidence.path,
            recorded_hash: recordedHash,
            observed_hash: observedHash,
            reason: 'hash_changed',
          });
          await lore.markStale(
            project,
            item.memoryKey,
            `The evidence file "${evidence.path}" changed since this entry was recorded.`,
          );
          markedStale.push(item.memoryKey);
          break;
        }
      }
    }

    if (markedStale.length > 0) {
      await ctx.services.jobs.enqueue({
        projectId: project.id,
        jobType: 'context_snapshot',
        entityType: 'project',
        entityId: project.id,
        dedupeKey: `snapshot:${project.id}`,
        payload: { project_id: project.id },
        correlationId: request.id,
      });
    }

    return {
      checked: body.observations.length,
      drifted,
      marked_stale: [...new Set(markedStale)],
    } satisfies EvidenceCheckResponse;
  });

  // --- links ---------------------------------------------------------------

  app.get('/api/projects/:projectRef/lore-links', async (request) => {
    request.requirePermission('lore:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const query = parseOrThrow(listLinksQuerySchema, request.query ?? {}, 'query');
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);
    // Confirmed unless asked otherwise: the graph is the default answer, the review queue is
    // something a caller opts into.
    const links = await ctx.repositories.links.listForProject(
      ctx.pool,
      project.id,
      query.state ?? 'confirmed',
    );
    return { items: links.map(presentMemoryLink) };
  });

  app.post('/api/projects/:projectRef/lore-links', async (request, reply) => {
    request.requirePermission('lore:propose');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(createLinkRequestSchema, request.body);
    const project = await resolveWritableProject(ctx, request, params.projectRef);

    const [from, to] = await Promise.all([
      lore.getEntry(project.id, body.from_memory_key),
      lore.getEntry(project.id, body.to_memory_key),
    ]);

    const link = await ctx.services.createLink({
      projectId: project.id,
      fromMemoryItemId: from.id,
      relation: body.relation,
      toMemoryItemId: to.id,
      metadata: body.metadata ?? {},
    });
    void reply.status(201);
    return { link: presentMemoryLink(link) };
  });

  app.post('/api/lore-links/:linkId/confirm', async (request) => {
    request.requirePermission('lore:propose');
    const { linkId } = request.params as { linkId: string };
    const link = await ctx.repositories.links.findById(ctx.pool, linkId);
    if (link === null) throw new SagaError('NOT_FOUND', 'No such relation.');
    await assertUpdateVisible(ctx, request, link.projectId);

    const confirmed = await ctx.services.confirmLink(linkId);
    if (confirmed === null) {
      // Already confirmed. Distinct from "no such relation", because the caller is looking at
      // a review queue somebody else has already worked through.
      throw new SagaError(
        'MEMORY_LINK_NOT_PROPOSED',
        'That relation is already part of the graph.',
      );
    }
    return { link: presentMemoryLink(confirmed) };
  });

  app.delete('/api/lore-links/:linkId', async (request) => {
    request.requirePermission('lore:propose');
    const { linkId } = request.params as { linkId: string };
    const link = await ctx.repositories.links.findById(ctx.pool, linkId);
    if (link === null) throw new SagaError('NOT_FOUND', 'No such relation.');
    await assertUpdateVisible(ctx, request, link.projectId);

    // Turning down a proposal keeps the row as a tombstone; removing a real relation removes
    // it. Deleting a proposal instead would only hold until the next publish re-proposed it.
    if (link.state === 'proposed') {
      await ctx.services.rejectLink(linkId);
      return { ok: true as const };
    }
    await ctx.services.deleteLink(linkId);
    return { ok: true as const };
  });

  // --- context -------------------------------------------------------------

  app.post('/api/projects/:projectRef/context', async (request) => {
    request.requirePermission('lore:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const body = parseOrThrow(contextRequestSchema, request.body ?? {});
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);

    const composed = await context.compose(project, body);
    return {
      ...composed,
      bootstrap_plan: composed.bootstrap_required ? presentBootstrapPlan(true) : null,
    };
  });

  app.get('/api/projects/:projectRef/context/snapshot', async (request) => {
    request.requirePermission('lore:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);
    const snapshot = await lore.activeSnapshot(project.id);
    return {
      snapshot: snapshot === null ? null : presentSnapshot(snapshot),
      bootstrap_plan: snapshot === null ? presentBootstrapPlan(true) : null,
    };
  });
}

/** An agent token may only reach updates belonging to its own project. */
async function assertUpdateVisible(
  ctx: AppContext,
  request: { actor: { type: string; projectId?: string } },
  projectId: string,
): Promise<void> {
  const actor = request.actor;
  if (actor.type === 'agent' && actor.projectId !== projectId) {
    throw new SagaError('MEMORY_UPDATE_NOT_FOUND', 'No Lore update matches that id.');
  }
  void ctx;
}
