import { z } from 'zod';
import { SagaError } from './errors.js';

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const intFromEnv = (fallback: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    });

const strFromEnv = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : value));

export const PARTY_MODES = ['off', 'advisory', 'strict'] as const;
export type PartyMode = (typeof PARTY_MODES)[number];

export const configSchema = z.object({
  nodeEnv: strFromEnv('development').pipe(z.enum(['development', 'test', 'production'])),
  version: strFromEnv('0.1.0'),
  logLevel: strFromEnv('info').pipe(
    z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  ),

  api: z.object({
    host: strFromEnv('127.0.0.1'),
    port: intFromEnv(4319),
    publicUrl: strFromEnv('http://localhost:4320'),
    corsOrigins: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? '')
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),
    maxBodyBytes: intFromEnv(1_048_576),
  }),

  database: z.object({
    url: z.string().min(1, 'DATABASE_URL is required'),
    poolMax: intFromEnv(10),
    statementTimeoutMs: intFromEnv(15_000),
  }),

  security: z.object({
    sessionSecret: z.string().min(16, 'SAGA_SESSION_SECRET must be at least 16 characters'),
    sessionTtlHours: intFromEnv(12),
    cookieSecure: boolFromEnv.default(false),
    devAuthBypass: boolFromEnv.default(false),
    bootstrapAdminEmail: strFromEnv(''),
    bootstrapAdminPassword: strFromEnv(''),
    /** Login and device-flow endpoints are rate limited separately from the general API. */
    loginRateLimitPerMinute: intFromEnv(10),
    deviceRateLimitPerMinute: intFromEnv(20),
    apiRateLimitPerMinute: intFromEnv(300),
  }),

  worker: z.object({
    concurrency: intFromEnv(2),
    pollIntervalMs: intFromEnv(1_000),
    jobLeaseSeconds: intFromEnv(60),
    jobMaxAttempts: intFromEnv(5),
    serviceLeaseSeconds: intFromEnv(30),
    heartbeatIntervalMs: intFromEnv(10_000),
  }),

  embedding: z.object({
    provider: strFromEnv('fake').pipe(z.enum(['fake', 'ollama'])),
    dimensions: intFromEnv(768),
    model: strFromEnv('nomic-embed-text'),
    ollamaUrl: strFromEnv('http://127.0.0.1:11434'),
    timeoutMs: intFromEnv(30_000),
  }),

  /**
   * The model that proposes relations, separate from the embedding model because they are
   * different jobs: `nomic-embed-text` cannot answer a question. `fake` proposes nothing at
   * all, which is what keeps a default install and CI from needing a model server.
   */
  inference: z.object({
    provider: strFromEnv('fake').pipe(z.enum(['fake', 'ollama'])),
    model: strFromEnv('qwen2.5:7b-instruct'),
    ollamaUrl: strFromEnv('http://127.0.0.1:11434'),
    timeoutMs: intFromEnv(60_000),
    /** How many nearest neighbours of a published entry the model is asked to judge. */
    maxCandidates: intFromEnv(5),
    /** Proposals below this are dropped rather than queued for someone to read. */
    minConfidence: z
      .union([z.number(), z.string()])
      .optional()
      .transform((value) => {
        if (value === undefined || value === '') return 0.6;
        const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0.6;
      }),
  }),

  party: z.object({
    mode: strFromEnv('advisory').pipe(z.enum(PARTY_MODES)),
    agentRunLeaseSeconds: intFromEnv(90),
    claimLeaseSeconds: intFromEnv(90),
    sessionAbandonAfterMinutes: intFromEnv(180),
  }),

  context: z.object({
    coreTokens: intFromEnv(3_500),
    taskTokens: intFromEnv(4_000),
    continuationTokens: intFromEnv(2_500),
    partyTokens: intFromEnv(1_000),
  }),

  retention: z.object({
    jobDays: intFromEnv(14),
    systemEventDays: intFromEnv(30),
    idempotencyHours: intFromEnv(24),
  }),

  cli: z.object({
    // Where `pnpm --filter @saga/cli bundle` left the client executable that the API hands out
    // at /api/cli/saga. Left unset the route resolves it from its own compiled location, which
    // is right for both the container image and a systemd deployment running from a working
    // tree; it exists for layouts that keep the build output somewhere else entirely.
    artifactDir: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value === '' ? null : value)),
  }),
});

export type SagaConfig = z.infer<typeof configSchema>;

export type EnvSource = Record<string, string | undefined>;

export function loadConfig(env: EnvSource = process.env): SagaConfig {
  const raw = {
    nodeEnv: env.NODE_ENV,
    version: env.SAGA_VERSION,
    logLevel: env.LOG_LEVEL,
    api: {
      host: env.SAGA_API_HOST,
      port: env.SAGA_API_PORT,
      publicUrl: env.SAGA_PUBLIC_URL,
      corsOrigins: env.SAGA_CORS_ORIGINS,
      maxBodyBytes: env.SAGA_MAX_BODY_BYTES,
    },
    database: {
      url: env.DATABASE_URL ?? '',
      poolMax: env.SAGA_DB_POOL_MAX,
      statementTimeoutMs: env.SAGA_DB_STATEMENT_TIMEOUT_MS,
    },
    security: {
      sessionSecret: env.SAGA_SESSION_SECRET ?? '',
      sessionTtlHours: env.SAGA_SESSION_TTL_HOURS,
      cookieSecure: env.SAGA_COOKIE_SECURE ?? false,
      devAuthBypass: env.SAGA_DEV_AUTH_BYPASS ?? false,
      bootstrapAdminEmail: env.SAGA_BOOTSTRAP_ADMIN_EMAIL,
      bootstrapAdminPassword: env.SAGA_BOOTSTRAP_ADMIN_PASSWORD,
      loginRateLimitPerMinute: env.SAGA_LOGIN_RATE_LIMIT_PER_MINUTE,
      deviceRateLimitPerMinute: env.SAGA_DEVICE_RATE_LIMIT_PER_MINUTE,
      apiRateLimitPerMinute: env.SAGA_API_RATE_LIMIT_PER_MINUTE,
    },
    worker: {
      concurrency: env.SAGA_WORKER_CONCURRENCY,
      pollIntervalMs: env.SAGA_WORKER_POLL_INTERVAL_MS,
      jobLeaseSeconds: env.SAGA_JOB_LEASE_SECONDS,
      jobMaxAttempts: env.SAGA_JOB_MAX_ATTEMPTS,
      serviceLeaseSeconds: env.SAGA_SERVICE_LEASE_SECONDS,
      heartbeatIntervalMs: env.SAGA_HEARTBEAT_INTERVAL_MS,
    },
    embedding: {
      provider: env.SAGA_EMBEDDING_PROVIDER,
      dimensions: env.SAGA_EMBEDDING_DIMENSIONS,
      model: env.SAGA_EMBEDDING_MODEL,
      ollamaUrl: env.SAGA_OLLAMA_URL,
      timeoutMs: env.SAGA_EMBEDDING_TIMEOUT_MS,
    },
    inference: {
      provider: env.SAGA_INFERENCE_PROVIDER,
      model: env.SAGA_INFERENCE_MODEL,
      ollamaUrl: env.SAGA_OLLAMA_URL,
      timeoutMs: env.SAGA_INFERENCE_TIMEOUT_MS,
      maxCandidates: env.SAGA_INFERENCE_MAX_CANDIDATES,
      minConfidence: env.SAGA_INFERENCE_MIN_CONFIDENCE,
    },
    party: {
      mode: env.PARTY_MODE,
      agentRunLeaseSeconds: env.SAGA_AGENT_RUN_LEASE_SECONDS,
      claimLeaseSeconds: env.SAGA_CLAIM_LEASE_SECONDS,
      sessionAbandonAfterMinutes: env.SAGA_SESSION_ABANDON_AFTER_MINUTES,
    },
    context: {
      coreTokens: env.SAGA_CORE_CONTEXT_TOKENS,
      taskTokens: env.SAGA_TASK_CONTEXT_TOKENS,
      continuationTokens: env.SAGA_CONTINUATION_CONTEXT_TOKENS,
      partyTokens: env.SAGA_PARTY_CONTEXT_TOKENS,
    },
    retention: {
      jobDays: env.SAGA_JOB_RETENTION_DAYS,
      systemEventDays: env.SAGA_SYSTEM_EVENT_RETENTION_DAYS,
      idempotencyHours: env.SAGA_IDEMPOTENCY_RETENTION_HOURS,
    },
    cli: {
      artifactDir: env.SAGA_CLI_ARTIFACT_DIR,
    },
  };

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new SagaError('INTERNAL_ERROR', `Invalid Saga configuration:\n  ${issues.join('\n  ')}`, {
      details: { issues },
    });
  }

  const config = parsed.data;

  // A production process must never start with the development authentication bypass on.
  if (config.nodeEnv === 'production' && config.security.devAuthBypass) {
    throw new SagaError(
      'INTERNAL_ERROR',
      'SAGA_DEV_AUTH_BYPASS cannot be enabled when NODE_ENV=production.',
    );
  }
  if (config.nodeEnv === 'production' && !config.security.cookieSecure) {
    throw new SagaError(
      'INTERNAL_ERROR',
      'SAGA_COOKIE_SECURE must be enabled when NODE_ENV=production.',
    );
  }

  return config;
}
