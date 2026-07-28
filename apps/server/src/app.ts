import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { METRIC, metrics, SagaError } from '@saga/shared';
import { newRequestId } from '@saga/shared/ids';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AppContext } from './composition.js';
import { registerAuth } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLoreRoutes } from './routes/lore.js';
import { registerProjectRoutes, type ProjectStatsContributors } from './routes/projects.js';
import { registerPartyRoutes } from './routes/party.js';
import { registerQuestRoutes } from './routes/quest.js';
import { registerShrineRoutes } from './routes/shrine.js';

export interface BuildAppOptions {
  ctx: AppContext;
  projectStats?: ProjectStatsContributors;
  /** Extra route modules registered by later phases (Lore, Quest, Party, SSE). */
  extraRoutes?: ((app: FastifyInstance, ctx: AppContext) => void | Promise<void>)[];
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { ctx } = options;
  const isProduction = ctx.config.nodeEnv === 'production';

  const app = Fastify({
    // Fastify v5 takes a pre-built Pino instance via `loggerInstance`, not `logger`.
    // Widened to Fastify's own logger interface so every route module can keep using the
    // plain `FastifyInstance` type instead of a Pino-parameterised one.
    loggerInstance: ctx.logger as FastifyBaseLogger,
    // A caller-supplied request id is honoured so a trace survives the nginx hop, but it is
    // length-limited so it cannot be used to inject junk into every log line.
    genReqId: (request) => {
      const forwarded = request.headers['x-request-id'];
      if (typeof forwarded === 'string' && forwarded.length > 0 && forwarded.length <= 200) {
        return forwarded;
      }
      return newRequestId();
    },
    requestIdHeader: false,
    bodyLimit: ctx.config.api.maxBodyBytes,
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(helmet, {
    // Guild Hall is served by nginx, not by this process; a strict CSP here would only
    // apply to API responses and give a false sense of coverage.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  await app.register(cookie, { secret: ctx.config.security.sessionSecret });

  await app.register(cors, {
    origin: (origin, callback) => {
      // No Origin header means a same-origin or non-browser client (the CLI, curl).
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      const allowed = [ctx.config.api.publicUrl, ...ctx.config.api.corsOrigins];
      callback(null, allowed.includes(origin));
    },
    credentials: true,
  });

  await app.register(rateLimit, {
    global: false,
    max: ctx.config.security.apiRateLimitPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (request) => `${request.ip}:${request.actor?.type ?? 'anonymous'}`,
  });

  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header('x-request-id', request.id);
    return payload;
  });

  // Request throughput and latency. Health probes are excluded so a one-second monitor does
  // not drown out the numbers an operator actually wants to read.
  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/health/')) return;
    metrics.increment(METRIC.httpRequests);
    metrics.observe(METRIC.httpRequestDuration, reply.elapsedTime);
  });

  registerErrorHandler(app, !isProduction);
  registerAuth(app, {
    auth: ctx.services.auth,
    devAuthBypass: ctx.config.security.devAuthBypass,
    cookieSecure: ctx.config.security.cookieSecure,
    sessionTtlHours: ctx.config.security.sessionTtlHours,
  });

  registerHealthRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerProjectRoutes(app, ctx, {
    // Each domain contributes its own per-project counters (ADR-0001).
    lore: (projectIds) => ctx.repositories.memory.countsForProjects(ctx.pool, projectIds),
    quest: (projectIds) => ctx.repositories.quests.counts(ctx.pool, projectIds),
    party: async (projectIds) => {
      const counts = await ctx.repositories.party.countLiveByProject(ctx.pool, projectIds);
      return new Map([...counts].map(([id, activeAgents]) => [id, { activeAgents }]));
    },
    ...options.projectStats,
  });
  registerShrineRoutes(app, ctx);
  registerLoreRoutes(app, ctx);
  registerQuestRoutes(app, ctx);
  registerPartyRoutes(app, ctx);
  registerEventRoutes(app, ctx);

  for (const register of options.extraRoutes ?? []) {
    await register(app, ctx);
  }

  app.get('/api', async () => ({
    name: 'Saga',
    tagline: 'No agent starts at level one.',
    version: ctx.config.version,
    domains: ['lore', 'quest', 'party', 'shrine'],
  }));

  await app.ready();
  return app;
}

/** Guard used by `main.ts`: never let a misconfigured production process bind a port. */
export function assertProductionSafety(ctx: AppContext): void {
  if (ctx.config.nodeEnv !== 'production') return;
  const problems = ctx.configProblems();
  if (problems.length > 0) {
    throw new SagaError(
      'INTERNAL_ERROR',
      `Refusing to start in production: ${problems.join('; ')}.`,
      { details: { problems } },
    );
  }
}
