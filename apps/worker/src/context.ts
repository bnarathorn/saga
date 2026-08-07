import {
  PgIdempotencyRepository,
  PgOutboxRepository,
  PgProjectRepository,
  ProjectService,
  type IdempotencyRepository,
  type OutboxRepository,
  type ProjectRepository,
} from '@saga/core';
import { createPool, type SagaPool } from '@saga/database';
import { PartyRepository, PartyService } from '@saga/party';
import { QuestRepository, QuestService, SessionService } from '@saga/quest';
import {
  LinkRepository,
  LoreService,
  MemoryRepository,
  RelationService,
  SearchRepository,
  SnapshotRepository,
  createEmbeddingProvider,
  createRelationProposer,
  type EmbeddingProvider,
} from '@saga/lore';
import {
  JobHandlerRegistry,
  JobService,
  PgJobRepository,
  PgServiceInstanceRepository,
  PgSystemEventRepository,
  type JobRepository,
  type ServiceInstanceRepository,
  type SystemEventRepository,
} from '@saga/shrine';
import type { SagaConfig } from '@saga/shared/config';
import { createLogger, type SagaLogger } from '@saga/shared/logging';
import { OutboxDispatcherRegistry } from './handlers/outbox-delivery.js';

/**
 * The worker composes its own dependency graph rather than importing the API's. It needs
 * repositories and services but no HTTP layer, and keeping the two independent means the
 * worker cannot accidentally acquire a web concern.
 */
export interface WorkerContext {
  config: SagaConfig;
  pool: SagaPool;
  logger: SagaLogger;
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
    quests: QuestRepository;
    party: PartyRepository;
  };
  services: {
    jobs: JobService;
    projects: ProjectService;
    lore: LoreService;
    relations: RelationService;
    quests: QuestService;
    sessions: SessionService;
    party: PartyService;
  };
  embeddings: EmbeddingProvider;
  handlers: JobHandlerRegistry;
  dispatchers: OutboxDispatcherRegistry;
  shutdown(): Promise<void>;
}

export function buildWorkerContext(options: {
  config: SagaConfig;
  pool?: SagaPool;
  logger?: SagaLogger;
}): WorkerContext {
  const { config } = options;
  const logger =
    options.logger ??
    createLogger({ level: config.logLevel, role: 'worker', version: config.version });

  const ownsPool = options.pool === undefined;
  const pool =
    options.pool ??
    createPool({
      connectionString: config.database.url,
      // Each concurrent handler may hold a connection, plus headroom for maintenance work.
      max: Math.max(4, config.worker.concurrency + 3),
      statementTimeoutMs: config.database.statementTimeoutMs,
      applicationName: 'saga-worker',
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
    quests: new QuestRepository(),
    party: new PartyRepository(),
  };

  const jobs = new JobService({
    pool,
    jobs: repositories.jobs,
    events: repositories.events,
    jobLeaseSeconds: config.worker.jobLeaseSeconds,
    jobMaxAttempts: config.worker.jobMaxAttempts,
  });

  const projects = new ProjectService({
    pool,
    projects: repositories.projects,
    outbox: repositories.outbox,
  });

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

  const relations = new RelationService({
    pool,
    memory: repositories.memory,
    links: repositories.links,
    search: repositories.search,
    proposer: createRelationProposer({
      provider: config.inference.provider,
      model: config.inference.model,
      ollamaUrl: config.inference.ollamaUrl,
      timeoutMs: config.inference.timeoutMs,
    }),
    maxCandidates: config.inference.maxCandidates,
    minConfidence: config.inference.minConfidence,
  });

  const questService = new QuestService({
    pool,
    quests: repositories.quests,
    projects: repositories.projects,
    outbox: repositories.outbox,
    jobs,
  });

  const sessionService = new SessionService({
    pool,
    quests: repositories.quests,
    questService,
    projects: repositories.projects,
    outbox: repositories.outbox,
    party: {},
    abandonAfterMinutes: config.party.sessionAbandonAfterMinutes,
  });

  const partyService = new PartyService({
    pool,
    party: repositories.party,
    quests: repositories.quests,
    outbox: repositories.outbox,
    mode: config.party.mode,
    agentRunLeaseSeconds: config.party.agentRunLeaseSeconds,
    claimLeaseSeconds: config.party.claimLeaseSeconds,
  });

  return {
    config,
    pool,
    logger,
    repositories,
    embeddings,
    services: {
      jobs,
      projects,
      lore,
      relations,
      quests: questService,
      sessions: sessionService,
      party: partyService,
    },
    handlers: new JobHandlerRegistry(),
    dispatchers: new OutboxDispatcherRegistry(),
    async shutdown() {
      if (ownsPool) await pool.end();
    },
  };
}
