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
      // Which deployment answered, so a destructive local script can refuse a production
      // target before it writes anything. `scripts/verify.ts` used to trust the port alone,
      // and 127.0.0.1:4319 is the reference deployment's port as well as the dev default.
      environment: ctx.config.nodeEnv,
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
