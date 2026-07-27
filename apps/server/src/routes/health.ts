import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../composition.js';

/**
 * `/health/live` answers "is this process able to serve a response" and must never touch the
 * database — otherwise a database outage would make the orchestrator restart healthy
 * processes. `/health/ready` is the one that checks dependencies.
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health/live', async () => ({
    status: 'ok' as const,
    uptime_seconds: Math.round((Date.now() - ctx.startedAt.getTime()) / 1000),
  }));

  app.get('/health/ready', async (_request, reply) => {
    const report = await ctx.health.run('readiness');
    const ready = report.status === 'healthy' || report.status === 'degraded';
    void reply.status(ready ? 200 : 503);
    return {
      status: ready ? ('ready' as const) : ('not_ready' as const),
      checks: report.checks.map((check) => ({
        name: check.name,
        status: check.status,
        message: check.message,
        detail: check.detail,
        duration_ms: check.durationMs,
      })),
    };
  });
}
