import {
  enqueueProbeRequestSchema,
  jobActionRequestSchema,
  listEventsQuerySchema,
  listJobsQuerySchema,
  type ShrineHealthDto,
} from '@saga/contracts';
import { sanitizeConfig } from '@saga/shrine';
import { SagaError, clampPageSize } from '@saga/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../composition.js';
import {
  presentJob,
  presentServiceInstance,
  presentSystemEvent,
  presentAuditEntry,
} from '../lib/presenters.js';
import { parseOrThrow } from '../lib/validation.js';
import { MIGRATIONS_DIR } from '../composition.js';
import { migrationStatus } from '@saga/database';

export function registerShrineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { jobs, audit, metrics } = ctx.services;

  app.get('/api/shrine/health', async (request): Promise<ShrineHealthDto> => {
    request.requirePermission('shrine:read');
    const report = await ctx.health.run();
    return {
      status: report.status,
      version: ctx.config.version,
      checked_at: new Date().toISOString(),
      checks: report.checks.map((check) => ({
        name: check.name,
        status: check.status,
        message: check.message,
        detail: check.detail,
        duration_ms: check.durationMs,
      })),
    };
  });

  app.get('/api/shrine/services', async (request) => {
    request.requirePermission('shrine:read');
    const now = new Date();
    const instances = await ctx.repositories.services.list(ctx.pool);
    return { items: instances.map((instance) => presentServiceInstance(instance, now)) };
  });

  app.get('/api/shrine/jobs', async (request) => {
    request.requirePermission('shrine:read');
    const query = parseOrThrow(listJobsQuerySchema, request.query, 'query');
    const page = await jobs.list({
      state: query.state,
      jobType: query.job_type,
      projectId: query.project_id,
      cursor: query.cursor,
      limit: clampPageSize(query.limit),
    });
    return {
      items: page.items.map(presentJob),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    };
  });

  app.get('/api/shrine/jobs/:jobId', async (request) => {
    request.requirePermission('shrine:read');
    const { jobId } = request.params as { jobId: string };
    return { job: presentJob(await jobs.get(jobId)) };
  });

  for (const action of ['retry', 'cancel', 'requeue'] as const) {
    app.post(`/api/shrine/jobs/:jobId/${action}`, async (request) => {
      // Viewers can inspect the queue but never operate it.
      request.requirePermission('shrine:operate');
      const { jobId } = request.params as { jobId: string };
      const body = parseOrThrow(jobActionRequestSchema, request.body ?? {});
      const actor = request.actor;

      const job =
        action === 'retry'
          ? await jobs.adminRetry(jobId, request.actorLabel, body.reason)
          : action === 'cancel'
            ? await jobs.adminCancel(jobId, request.actorLabel, body.reason)
            : await jobs.adminRequeue(jobId, request.actorLabel, body.reason);

      await audit.record({
        actorType: actor.type === 'user' ? 'user' : 'agent',
        actorId: actor.type === 'user' ? actor.userId : null,
        actorLabel: request.actorLabel,
        action: `shrine.job_${action}`,
        projectId: job.projectId,
        entityType: 'job',
        entityId: job.id,
        reason: body.reason,
        requestId: request.id,
        metadata: { job_type: job.jobType },
      });

      return { job: presentJob(job) };
    });
  }

  app.post('/api/shrine/jobs/probe', async (request, reply) => {
    // Bounded on purpose: an operator may prove the queue drains, but Shrine never becomes a
    // generic job-payload editor or command runner.
    request.requirePermission('shrine:operate');
    const body = parseOrThrow(enqueueProbeRequestSchema, request.body ?? {});
    const job = await jobs.enqueue({
      jobType: 'noop',
      projectId: body.project_id ?? null,
      payload: {
        echo: body.echo ?? `probe from ${request.actorLabel}`,
        sleep_ms: body.sleep_ms ?? 0,
        ...(body.fail === undefined ? {} : { fail: body.fail }),
      },
      correlationId: request.id,
      maxAttempts: body.fail === 'retryable' ? 2 : undefined,
    });
    if (job === null) {
      throw new SagaError('CONFLICT', 'An identical probe job is already queued.');
    }
    await audit.record({
      actorType: request.actor.type === 'user' ? 'user' : 'agent',
      actorId: request.actor.type === 'user' ? request.actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'shrine.job_probe',
      projectId: job.projectId,
      entityType: 'job',
      entityId: job.id,
      requestId: request.id,
    });
    void reply.status(201);
    return { job: presentJob(job) };
  });

  app.get('/api/shrine/events', async (request) => {
    request.requirePermission('shrine:read');
    const query = parseOrThrow(listEventsQuerySchema, request.query, 'query');
    const limit = clampPageSize(query.limit);

    if (query.since_sequence !== undefined) {
      const events = await ctx.repositories.events.since(ctx.pool, query.since_sequence, limit);
      return { items: events.map(presentSystemEvent), next_cursor: null, has_more: false };
    }

    const events = await ctx.repositories.events.list(ctx.pool, {
      severity: query.severity,
      category: query.category,
      projectId: query.project_id,
      cursorKey: query.cursor,
      limit: limit + 1,
    });
    const hasMore = events.length > limit;
    const items = hasMore ? events.slice(0, limit) : events;
    return {
      items: items.map(presentSystemEvent),
      next_cursor: hasMore ? String(items.at(-1)?.sequence ?? '') : null,
      has_more: hasMore,
    };
  });

  app.get('/api/shrine/config', async (request) => {
    request.requirePermission('shrine:read');
    return { config: sanitizeConfig(ctx.config, ctx.startedAt) };
  });

  app.get('/api/shrine/schema', async (request) => {
    request.requirePermission('shrine:read');
    const status = await migrationStatus(ctx.pool, MIGRATIONS_DIR);
    return {
      schema: {
        current_version: status.currentVersion,
        expected_version: status.expectedVersion,
        up_to_date: status.upToDate,
        applied: status.applied.map((row) => ({
          version: row.version,
          name: row.name,
          applied_at: row.applied_at.toISOString(),
        })),
        pending: status.pending.map((file) => ({ version: file.version, name: file.name })),
      },
    };
  });

  app.get('/api/shrine/metrics-summary', async (request) => {
    request.requirePermission('shrine:read');
    return { metrics: await metrics.summary() };
  });

  app.get('/api/shrine/audit', async (request) => {
    request.requirePermission('security:manage');
    const query = request.query as {
      project_id?: string;
      action?: string;
      cursor?: string;
      limit?: string;
    };
    const page = await audit.list({
      projectId: query.project_id,
      action: query.action,
      cursor: query.cursor,
      limit: clampPageSize(query.limit === undefined ? undefined : Number(query.limit)),
    });
    return {
      items: page.items.map(presentAuditEntry),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    };
  });
}
