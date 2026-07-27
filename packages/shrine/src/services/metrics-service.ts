import type { MetricsSummaryDto } from '@saga/contracts';
import type { SagaPool } from '@saga/database';
import type { OutboxRepository, ProjectRepository } from '@saga/core';
import type { JobRepository } from '../repositories/job-repository.js';
import type { ServiceInstanceRepository } from '../repositories/service-instance-repository.js';

/**
 * Domains above Shrine contribute their own counters instead of Shrine querying their tables
 * (ADR-0001). A missing contributor reports zero rather than failing the whole summary.
 */
export interface MetricsContributors {
  lore?: () => Promise<{ entries: number; stale: number }>;
  quest?: () => Promise<{ open: number; blocked: number }>;
  party?: () => Promise<{ activeAgentRuns: number; activeClaims: number }>;
  sseClients?: () => number;
}

export interface MetricsServiceDeps {
  pool: SagaPool;
  jobs: JobRepository;
  services: ServiceInstanceRepository;
  outbox: OutboxRepository;
  projects: ProjectRepository;
  contributors: MetricsContributors;
}

export class MetricsService {
  constructor(private readonly deps: MetricsServiceDeps) {}

  async summary(): Promise<MetricsSummaryDto> {
    const { pool, jobs, services, outbox, projects, contributors } = this.deps;

    const [jobCounts, liveServices, outboxCounts, projectCounts, lore, quest, party] =
      await Promise.all([
        jobs.counts(pool),
        services.countLive(pool),
        outbox.counts(pool),
        projects.countByStatus(pool),
        contributors.lore?.() ?? Promise.resolve({ entries: 0, stale: 0 }),
        contributors.quest?.() ?? Promise.resolve({ open: 0, blocked: 0 }),
        contributors.party?.() ?? Promise.resolve({ activeAgentRuns: 0, activeClaims: 0 }),
      ]);

    return {
      collected_at: new Date().toISOString(),
      projects: { total: projectCounts.total, active: projectCounts.active },
      jobs: {
        queued: jobCounts.queued,
        claimed: jobCounts.claimed,
        retrying: jobCounts.retrying,
        failed: jobCounts.failed,
        succeeded_last_hour: jobCounts.succeededLastHour,
        oldest_queued_age_seconds: jobCounts.oldestQueuedAgeSeconds,
      },
      outbox: { pending: outboxCounts.pending, failed: outboxCounts.failed },
      services: { api_live: liveServices.api, worker_live: liveServices.worker },
      party: { active_agent_runs: party.activeAgentRuns, active_claims: party.activeClaims },
      lore: { entries: lore.entries, stale: lore.stale },
      quest: { open: quest.open, blocked: quest.blocked },
      sse: { clients: contributors.sseClients?.() ?? 0 },
    };
  }
}
