import { fileURLToPath } from 'node:url';
import {
  AgentTokenRepository,
  AuthService,
  DeviceCodeRepository,
  PgIdempotencyRepository,
  PgOutboxRepository,
  PgProjectRepository,
  ProjectService,
  UserRepository,
  WebSessionRepository,
  type IdempotencyRepository,
  type OutboxRepository,
  type ProjectRepository,
} from '@saga/core';
import { createPool, migrationStatus, withTransaction, type SagaPool } from '@saga/database';
import {
  ContextService,
  LinkRepository,
  LoreService,
  MemoryRepository,
  SearchRepository,
  SearchService,
  SnapshotRepository,
  createEmbeddingProvider,
  type EmbeddingProvider,
  type MemoryLink,
} from '@saga/lore';
import type { MemoryRelation } from '@saga/contracts';
import {
  AuditService,
  HealthRegistry,
  JobService,
  MetricsService,
  PgJobRepository,
  PgServiceInstanceRepository,
  PgSystemEventRepository,
  configHealthContributor,
  databaseHealthContributor,
  devAuthBypassContributor,
  queueHealthContributor,
  schemaHealthContributor,
  workerHealthContributor,
  type JobRepository,
  type MetricsContributors,
  type ServiceInstanceRepository,
  type SystemEventRepository,
} from '@saga/shrine';
import type { SagaConfig } from '@saga/shared/config';
import { createLogger, type SagaLogger } from '@saga/shared/logging';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

/**
 * The single place where domains are wired together. Reading this file top to bottom shows
 * the whole system's shape: repositories, then services, then the cross-domain registries.
 */
export interface AppContext {
  config: SagaConfig;
  pool: SagaPool;
  logger: SagaLogger;
  startedAt: Date;

  repositories: {
    projects: ProjectRepository;
    outbox: OutboxRepository;
    idempotency: IdempotencyRepository;
    jobs: JobRepository;
    services: ServiceInstanceRepository;
    events: SystemEventRepository;
    memory: MemoryRepository;
    snapshots: SnapshotRepository;
    links: LinkRepository;
    search: SearchRepository;
  };

  services: {
    projects: ProjectService;
    auth: AuthService;
    jobs: JobService;
    audit: AuditService;
    metrics: MetricsService;
    lore: LoreService;
    loreSearch: SearchService;
    context: ContextService;
    createLink(input: {
      projectId: string;
      fromMemoryItemId: string;
      relation: MemoryRelation;
      toMemoryItemId: string;
      metadata: Record<string, unknown>;
    }): Promise<MemoryLink>;
    deleteLink(id: string): Promise<boolean>;
  };

  embeddings: EmbeddingProvider;

  health: HealthRegistry;
  metricsContributors: MetricsContributors;
  /** Cached because the schema version cannot change while the process is running. */
  schemaVersion: () => Promise<{ currentVersion: number; expectedVersion: number }>;
  configProblems: () => string[];
  shutdown(): Promise<void>;
}

export interface BuildContextOptions {
  config: SagaConfig;
  pool?: SagaPool;
  logger?: SagaLogger;
  role?: 'api' | 'worker' | 'test';
}

export function buildContext(options: BuildContextOptions): AppContext {
  const { config } = options;
  const logger =
    options.logger ??
    createLogger({
      level: config.logLevel,
      role: options.role === 'worker' ? 'worker' : 'api',
      version: config.version,
    });

  const ownsPool = options.pool === undefined;
  const pool =
    options.pool ??
    createPool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      statementTimeoutMs: config.database.statementTimeoutMs,
      applicationName: `saga-${options.role ?? 'api'}`,
      onError: (error) => logger.error({ err: error }, 'idle postgres client error'),
    });

  const repositories = {
    projects: new PgProjectRepository(),
    outbox: new PgOutboxRepository(),
    idempotency: new PgIdempotencyRepository(),
    jobs: new PgJobRepository(),
    services: new PgServiceInstanceRepository(),
    events: new PgSystemEventRepository(),
    memory: new MemoryRepository(),
    snapshots: new SnapshotRepository(),
    links: new LinkRepository(),
    search: new SearchRepository(),
  };

  const projects = new ProjectService({
    pool,
    projects: repositories.projects,
    outbox: repositories.outbox,
  });

  const auth = new AuthService({
    pool,
    users: new UserRepository(),
    sessions: new WebSessionRepository(),
    agentTokens: new AgentTokenRepository(),
    deviceCodes: new DeviceCodeRepository(),
    projects: repositories.projects,
    sessionTtlHours: config.security.sessionTtlHours,
    publicUrl: config.api.publicUrl,
  });

  const jobs = new JobService({
    pool,
    jobs: repositories.jobs,
    events: repositories.events,
    jobLeaseSeconds: config.worker.jobLeaseSeconds,
    jobMaxAttempts: config.worker.jobMaxAttempts,
  });

  const audit = new AuditService(pool);
  const metricsContributors: MetricsContributors = {};

  const embeddings = createEmbeddingProvider({
    provider: config.embedding.provider,
    dimensions: config.embedding.dimensions,
    model: config.embedding.model,
    ollamaUrl: config.embedding.ollamaUrl,
    timeoutMs: config.embedding.timeoutMs,
  });

  const lore = new LoreService({
    pool,
    memory: repositories.memory,
    snapshots: repositories.snapshots,
    projects: repositories.projects,
    outbox: repositories.outbox,
    jobs,
    coreContextTokens: config.context.coreTokens,
  });

  const loreSearch = new SearchService({
    pool,
    search: repositories.search,
    memory: repositories.memory,
    links: repositories.links,
    embeddings,
    logger,
  });

  const context = new ContextService({
    pool,
    memory: repositories.memory,
    snapshots: repositories.snapshots,
    search: loreSearch,
    budgets: {
      core: config.context.coreTokens,
      task: config.context.taskTokens,
      continuation: config.context.continuationTokens,
      party: config.context.partyTokens,
    },
  });

  // Lore counters are contributed to Shrine rather than queried by it (ADR-0001).
  metricsContributors.lore = async () => repositories.memory.totals(pool);

  const metrics = new MetricsService({
    pool,
    jobs: repositories.jobs,
    services: repositories.services,
    outbox: repositories.outbox,
    projects: repositories.projects,
    contributors: metricsContributors,
  });

  let cachedSchema: { currentVersion: number; expectedVersion: number } | null = null;
  const schemaVersion = async () => {
    if (cachedSchema !== null) return cachedSchema;
    const status = await migrationStatus(pool, MIGRATIONS_DIR);
    cachedSchema = { currentVersion: status.currentVersion, expectedVersion: status.expectedVersion };
    return cachedSchema;
  };

  const configProblems = (): string[] => {
    const problems: string[] = [];
    if (config.security.sessionSecret.length < 32) {
      problems.push('SAGA_SESSION_SECRET should be at least 32 characters');
    }
    if (config.nodeEnv === 'production' && config.security.devAuthBypass) {
      problems.push('SAGA_DEV_AUTH_BYPASS is enabled in production');
    }
    return problems;
  };

  const health = new HealthRegistry();
  health.register(databaseHealthContributor(pool));
  health.register(schemaHealthContributor(schemaVersion));
  health.register(configHealthContributor(configProblems));
  health.register(
    workerHealthContributor(async () => {
      const live = await repositories.services.countLive(pool);
      return { liveWorkers: live.worker, desiredWorkers: 1 };
    }),
  );
  health.register(
    queueHealthContributor(async () => {
      const counts = await repositories.jobs.counts(pool);
      return {
        oldestQueuedAgeSeconds: counts.oldestQueuedAgeSeconds,
        failed: counts.failed,
        queued: counts.queued,
      };
    }),
  );
  health.register(devAuthBypassContributor(config.security.devAuthBypass));
  health.register({
    name: 'embedding_provider',
    // Not a readiness check: text search keeps working without embeddings, so an outage here
    // is `degraded`, never a reason to take the API out of rotation (acceptance criterion 20).
    readiness: false,
    async check() {
      const health = await embeddings.healthCheck();
      return {
        name: 'embedding_provider',
        status: health.status === 'unhealthy' ? 'degraded' : health.status,
        message:
          health.status === 'unhealthy'
            ? `${health.message} Vector search is unavailable; full-text and trigram search continue to work.`
            : health.message,
        detail: { provider: embeddings.name, ...health.detail },
      };
    },
  });

  return {
    config,
    pool,
    logger,
    startedAt: new Date(),
    repositories,
    embeddings,
    services: {
      projects,
      auth,
      jobs,
      audit,
      metrics,
      lore,
      loreSearch,
      context,
      createLink: (input) => withTransaction(pool, (tx) => repositories.links.create(tx, input)),
      deleteLink: (id) => withTransaction(pool, (tx) => repositories.links.delete(tx, id)),
    },
    health,
    metricsContributors,
    schemaVersion,
    configProblems,
    async shutdown() {
      if (ownsPool) await pool.end();
    },
  };
}
