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
} from '@saga/core';
import { createPool, type SagaPool } from '@saga/database';
import {
  AuditService,
  JobService,
  PgJobRepository,
  PgServiceInstanceRepository,
  PgSystemEventRepository,
} from '@saga/shrine';
import { loadConfig, type SagaConfig } from '@saga/shared/config';
import { loadDotEnv } from '@saga/shared/dotenv';
import { createSilentLogger } from '@saga/shared/logging';

loadDotEnv();

const TRUNCATION_ORDER = [
  'party.claims',
  'party.resources',
  'party.agent_runs',
  'quest.checkpoints',
  'quest.sessions',
  'quest.work_item_dependencies',
  'quest.work_items',
  'lore.memory_links',
  'lore.memory_update_items',
  'lore.memory_updates',
  'lore.context_snapshots',
  'lore.memory_versions',
  'lore.memory_items',
  'shrine.jobs',
  'shrine.system_events',
  'shrine.service_instances',
  'core.outbox_events',
  'core.idempotency_records',
  'core.project_aliases',
  'core.projects',
  'security.audit_logs',
  'security.device_codes',
  'security.agent_tokens',
  'security.web_sessions',
  'security.users',
];

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): SagaConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.SAGA_TEST_DATABASE_URL ?? '',
    SAGA_SESSION_SECRET: 'test-session-secret-that-is-long-enough-0123456789',
    SAGA_BOOTSTRAP_ADMIN_EMAIL: '',
    SAGA_BOOTSTRAP_ADMIN_PASSWORD: '',
    // Rate limits are exercised by their own dedicated test, not by every login the suite makes.
    SAGA_LOGIN_RATE_LIMIT_PER_MINUTE: '10000',
    SAGA_API_RATE_LIMIT_PER_MINUTE: '100000',
    ...overrides,
  });
}

export function createTestPool(applicationName = 'saga-test'): SagaPool {
  const url = process.env.SAGA_TEST_DATABASE_URL;
  if (url === undefined || url.trim().length === 0) {
    throw new Error('SAGA_TEST_DATABASE_URL is not set.');
  }
  return createPool({ connectionString: url, max: 8, applicationName, statementTimeoutMs: 30_000 });
}

/** Wipe every domain table. Skips tables a partially migrated database does not have yet. */
export async function truncateAll(pool: SagaPool): Promise<void> {
  const existing = await pool.query<{ qualified: string }>(
    `SELECT format('%I.%I', schemaname, tablename) AS qualified
       FROM pg_tables
      WHERE schemaname IN ('core','lore','quest','party','shrine','security')`,
  );
  const present = new Set(existing.rows.map((row) => row.qualified));
  const targets = TRUNCATION_ORDER.filter((table) => present.has(table));
  if (targets.length === 0) return;
  await pool.query(`TRUNCATE ${targets.join(', ')} RESTART IDENTITY CASCADE`);
}

export interface TestServices {
  pool: SagaPool;
  config: SagaConfig;
  repositories: ReturnType<typeof buildRepositories>;
  projects: ProjectService;
  auth: AuthService;
  jobs: JobService;
  audit: AuditService;
  close(): Promise<void>;
}

function buildRepositories() {
  return {
    projects: new PgProjectRepository(),
    outbox: new PgOutboxRepository(),
    idempotency: new PgIdempotencyRepository(),
    jobs: new PgJobRepository(),
    services: new PgServiceInstanceRepository(),
    events: new PgSystemEventRepository(),
    users: new UserRepository(),
    sessions: new WebSessionRepository(),
    agentTokens: new AgentTokenRepository(),
    deviceCodes: new DeviceCodeRepository(),
  };
}

/** Build the domain services against the test database without any HTTP layer. */
export function createTestServices(
  options: { pool?: SagaPool; config?: SagaConfig } = {},
): TestServices {
  const config = options.config ?? testConfig();
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? createTestPool();
  const repositories = buildRepositories();

  const projects = new ProjectService({
    pool,
    projects: repositories.projects,
    outbox: repositories.outbox,
  });
  const auth = new AuthService({
    pool,
    users: repositories.users,
    sessions: repositories.sessions,
    agentTokens: repositories.agentTokens,
    deviceCodes: repositories.deviceCodes,
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

  return {
    pool,
    config,
    repositories,
    projects,
    auth,
    jobs,
    audit: new AuditService(pool),
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

export const silentLogger = createSilentLogger();
