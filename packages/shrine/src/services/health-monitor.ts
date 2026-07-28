import type { HealthState } from '@saga/contracts';
import type { SagaPool } from '@saga/database';
import { errorMessage } from '@saga/shared';
import type { SagaLogger } from '@saga/shared/logging';
import type { SystemEventRepository } from '../repositories/system-event-repository.js';
import type { HealthRegistry } from './health-service.js';

export const HEALTH_CHANGED_EVENT = 'shrine.health_changed';

export interface HealthMonitorDeps {
  pool: SagaPool;
  health: HealthRegistry;
  events: SystemEventRepository;
  logger: SagaLogger;
  intervalMs: number;
}

const SEVERITY: Record<HealthState, 'info' | 'warning' | 'error' | 'critical'> = {
  healthy: 'info',
  unknown: 'warning',
  degraded: 'warning',
  unhealthy: 'error',
};

/**
 * Emits `shrine.health_changed` (spec 11.4).
 *
 * Health itself is computed on demand, so nothing would ever notice a transition without a
 * process watching for one. Only *changes* are recorded — an unhealthy system must not fill
 * the feed with one row per tick, which is the same rule that keeps heartbeats out of it
 * (spec 7.19).
 *
 * Each evaluation runs the whole registry, which costs a handful of queries, so this ticks on
 * its own slower schedule rather than on the heartbeat interval: an idle server should not pay
 * for health it is not being asked about.
 *
 * The last known status is recovered from the feed rather than starting empty, so a restart
 * does not re-announce a status that is already recorded, and a second API instance does not
 * duplicate the first one's event. Concurrent instances can still race on the same transition;
 * the reference deployment runs one API process, and a duplicate row is cosmetic.
 */
export class HealthMonitor {
  private previous: HealthState | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HealthMonitorDeps) {}

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for the first evaluation at startup. */
  async tick(): Promise<HealthState | null> {
    try {
      const report = await this.deps.health.run();
      const previous = this.previous ?? (await this.lastRecordedStatus());
      this.previous = report.status;
      if (previous === report.status) return report.status;

      const degraded = report.checks.filter((check) => check.status !== 'healthy');
      await this.deps.events.record(this.deps.pool, {
        severity: SEVERITY[report.status],
        category: 'shrine',
        eventType: HEALTH_CHANGED_EVENT,
        message:
          previous === null
            ? `Shrine health is ${report.status}.`
            : `Shrine health changed from ${previous} to ${report.status}.`,
        metadata: {
          from: previous,
          to: report.status,
          failing_checks: degraded.map((check) => ({
            name: check.name,
            status: check.status,
            message: check.message,
          })),
        },
      });
      return report.status;
    } catch (error) {
      // A monitoring failure must never take the process down; the next tick retries.
      this.deps.logger.error({ err: error, reason: errorMessage(error) }, 'health monitor failed');
      return null;
    }
  }

  /** The `to` status of the newest health event, so a restart resumes where the feed left off. */
  private async lastRecordedStatus(): Promise<HealthState | null> {
    const last = await this.deps.events.latestOfType(this.deps.pool, HEALTH_CHANGED_EVENT);
    const to = last?.metadata.to;
    return typeof to === 'string' ? (to as HealthState) : null;
  }
}
