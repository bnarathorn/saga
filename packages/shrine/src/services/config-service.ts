import type { ShrineConfigDto } from '@saga/contracts';
import type { SagaConfig } from '@saga/shared/config';
import { REDACTED } from '@saga/shared';

/**
 * Render operational configuration for Shrine. Everything here is safe to display to an
 * operator: no credentials, no full DSNs, no session secret, no agent tokens.
 */
export function sanitizeConfig(config: SagaConfig, startedAt: Date): ShrineConfigDto {
  const { host, database } = describeDatabase(config.database.url);
  return {
    version: config.version,
    node_env: config.nodeEnv,
    started_at: startedAt.toISOString(),
    database: {
      host,
      database,
      pool_max: config.database.poolMax,
    },
    tls_enabled: config.api.publicUrl.startsWith('https://'),
    embedding: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
    },
    worker: {
      concurrency: config.worker.concurrency,
      job_lease_seconds: config.worker.jobLeaseSeconds,
      job_max_attempts: config.worker.jobMaxAttempts,
    },
    retention: {
      job_days: config.retention.jobDays,
      system_event_days: config.retention.systemEventDays,
      idempotency_hours: config.retention.idempotencyHours,
    },
    context_budgets: {
      core: config.context.coreTokens,
      task: config.context.taskTokens,
      continuation: config.context.continuationTokens,
      party: config.context.partyTokens,
    },
    party_mode: config.party.mode,
    dev_auth_bypass: config.security.devAuthBypass,
  };
}

/** Extract only host and database name; username and password never leave the process. */
export function describeDatabase(connectionString: string): { host: string; database: string } {
  try {
    const url = new URL(connectionString);
    // `new URL` accepts strings with no authority at all, such as `postgres://`. Reporting an
    // empty host would show an operator a blank field rather than saying it could not be read.
    if (url.hostname.length === 0) return { host: REDACTED, database: REDACTED };
    return {
      host: url.port.length > 0 ? `${url.hostname}:${url.port}` : url.hostname,
      database: url.pathname.replace(/^\//, '') || REDACTED,
    };
  } catch {
    return { host: REDACTED, database: REDACTED };
  }
}
