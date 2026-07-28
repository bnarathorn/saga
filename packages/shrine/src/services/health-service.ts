import type { HealthState } from '@saga/contracts';
import type { SagaPool } from '@saga/database';
import { errorMessage } from '@saga/shared';

export interface HealthCheckResult {
  name: string;
  status: HealthState;
  message: string;
  detail?: Record<string, unknown>;
}

export interface HealthCheckReport extends HealthCheckResult {
  detail: Record<string, unknown>;
  durationMs: number;
}

export interface HealthContributor {
  name: string;
  /** Readiness checks gate `/health/ready`; the rest only affect the Shrine health model. */
  readiness: boolean;
  check(): Promise<HealthCheckResult>;
}

const SEVERITY: Record<HealthState, number> = {
  healthy: 0,
  unknown: 1,
  degraded: 2,
  unhealthy: 3,
};

export function worstStatus(states: readonly HealthState[]): HealthState {
  return states.reduce<HealthState>(
    (worst, state) => (SEVERITY[state] > SEVERITY[worst] ? state : worst),
    'healthy',
  );
}

/**
 * Domains register their own health contributors at composition time rather than Shrine
 * reaching into other schemas — see ADR-0001.
 */
export class HealthRegistry {
  private readonly contributors: HealthContributor[] = [];

  register(contributor: HealthContributor): void {
    this.contributors.push(contributor);
  }

  async run(only?: 'readiness'): Promise<{ status: HealthState; checks: HealthCheckReport[] }> {
    const selected =
      only === 'readiness' ? this.contributors.filter((c) => c.readiness) : this.contributors;

    const checks = await Promise.all(
      selected.map(async (contributor): Promise<HealthCheckReport> => {
        const startedAt = Date.now();
        try {
          const result = await contributor.check();
          return {
            ...result,
            // The contributor's registered name wins: a check that omits it would otherwise
            // produce an unnamed report and break the sort below.
            name: contributor.name,
            detail: result.detail ?? {},
            durationMs: Date.now() - startedAt,
          };
        } catch (error) {
          // A contributor that throws is itself a health signal; never let it break the report.
          return {
            name: contributor.name,
            status: 'unhealthy',
            message: errorMessage(error),
            detail: {},
            durationMs: Date.now() - startedAt,
          };
        }
      }),
    );

    checks.sort((a, b) => a.name.localeCompare(b.name));
    return { status: worstStatus(checks.map((check) => check.status)), checks };
  }
}

export function databaseHealthContributor(pool: SagaPool): HealthContributor {
  return {
    name: 'database',
    readiness: true,
    async check(): Promise<HealthCheckResult> {
      const result = await pool.query<{ one: number }>('SELECT 1 AS one');
      if (result.rows[0]?.one !== 1) {
        return { name: 'database', status: 'unhealthy', message: 'Unexpected probe result.' };
      }
      return {
        name: 'database',
        status: 'healthy',
        message: 'PostgreSQL is reachable.',
        detail: {
          pool_total: pool.totalCount,
          pool_idle: pool.idleCount,
          pool_waiting: pool.waitingCount,
        },
      };
    },
  };
}

export interface SchemaHealthInput {
  currentVersion: number;
  expectedVersion: number;
}

export function schemaHealthContributor(load: () => Promise<SchemaHealthInput>): HealthContributor {
  return {
    name: 'schema',
    readiness: true,
    async check(): Promise<HealthCheckResult> {
      const { currentVersion, expectedVersion } = await load();
      if (currentVersion === expectedVersion) {
        return {
          name: 'schema',
          status: 'healthy',
          message: `Schema is at version ${currentVersion}.`,
          detail: { current_version: currentVersion, expected_version: expectedVersion },
        };
      }
      // A database ahead of the application is a rollback in progress; behind is a missed
      // migration. Both make the process unsafe to serve traffic.
      return {
        name: 'schema',
        status: 'unhealthy',
        message:
          currentVersion < expectedVersion
            ? `Database schema is at version ${currentVersion} but this build expects ${expectedVersion}. Run pnpm db:migrate.`
            : `Database schema is at version ${currentVersion}, ahead of this build's ${expectedVersion}.`,
        detail: { current_version: currentVersion, expected_version: expectedVersion },
      };
    },
  };
}

export function workerHealthContributor(
  load: () => Promise<{ liveWorkers: number; desiredWorkers: number }>,
): HealthContributor {
  return {
    name: 'workers',
    readiness: false,
    async check(): Promise<HealthCheckResult> {
      const { liveWorkers, desiredWorkers } = await load();
      if (liveWorkers >= desiredWorkers) {
        return {
          name: 'workers',
          status: 'healthy',
          message: `${liveWorkers} worker instance(s) holding a live lease.`,
          detail: { live: liveWorkers, desired: desiredWorkers },
        };
      }
      return {
        name: 'workers',
        status: 'degraded',
        message:
          liveWorkers === 0
            ? 'No worker is holding a live lease; background jobs will not run.'
            : `Only ${liveWorkers} of ${desiredWorkers} expected workers are live.`,
        detail: { live: liveWorkers, desired: desiredWorkers },
      };
    },
  };
}

export interface QueueHealthThresholds {
  oldestQueuedWarningSeconds: number;
  failedWarningCount: number;
}

export function queueHealthContributor(
  load: () => Promise<{ oldestQueuedAgeSeconds: number | null; failed: number; queued: number }>,
  thresholds: QueueHealthThresholds = { oldestQueuedWarningSeconds: 300, failedWarningCount: 1 },
): HealthContributor {
  return {
    name: 'job_queue',
    readiness: false,
    async check(): Promise<HealthCheckResult> {
      const { oldestQueuedAgeSeconds, failed, queued } = await load();
      const detail = {
        queued,
        failed,
        oldest_queued_age_seconds: oldestQueuedAgeSeconds,
      };
      const problems: string[] = [];
      if (
        oldestQueuedAgeSeconds !== null &&
        oldestQueuedAgeSeconds > thresholds.oldestQueuedWarningSeconds
      ) {
        problems.push(`the oldest queued job is ${Math.round(oldestQueuedAgeSeconds)}s old`);
      }
      if (failed >= thresholds.failedWarningCount) {
        problems.push(`${failed} job(s) have failed`);
      }
      if (problems.length === 0) {
        return {
          name: 'job_queue',
          status: 'healthy',
          message: 'The job queue is keeping up.',
          detail,
        };
      }
      return {
        name: 'job_queue',
        status: 'degraded',
        message: `The job queue needs attention: ${problems.join('; ')}.`,
        detail,
      };
    },
  };
}

export function devAuthBypassContributor(enabled: boolean): HealthContributor {
  return {
    name: 'auth_mode',
    readiness: false,
    async check(): Promise<HealthCheckResult> {
      if (!enabled) {
        return { name: 'auth_mode', status: 'healthy', message: 'Authentication is enforced.' };
      }
      return {
        name: 'auth_mode',
        status: 'degraded',
        message:
          'SAGA_DEV_AUTH_BYPASS is enabled: every request is treated as an administrator. Never use this outside local development.',
        detail: { dev_auth_bypass: true },
      };
    },
  };
}

export function configHealthContributor(problems: () => readonly string[]): HealthContributor {
  return {
    name: 'configuration',
    readiness: true,
    async check(): Promise<HealthCheckResult> {
      const issues = problems();
      if (issues.length === 0) {
        return {
          name: 'configuration',
          status: 'healthy',
          message: 'Required configuration is present.',
        };
      }
      return {
        name: 'configuration',
        status: 'unhealthy',
        message: `Required configuration is missing or invalid: ${issues.join('; ')}.`,
        detail: { issues: [...issues] },
      };
    },
  };
}
