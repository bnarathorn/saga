import type { LatencyDto, MetricsSummaryDto } from '@saga/contracts';
import type { SagaPool } from '@saga/database';
import type { OutboxRepository, ProjectRepository } from '@saga/core';
import { METRIC, metrics, type LatencySnapshot } from '@saga/shared';
import type { JobDurationStats, JobRepository } from '../repositories/job-repository.js';
import type { ServiceInstanceRepository } from '../repositories/service-instance-repository.js';

/** How far back job-derived latency looks. Long enough to survive a quiet period. */
const LATENCY_WINDOW_MS = 60 * 60_000;

const EMPTY_LATENCY: LatencyDto = { count: 0, mean_ms: 0, p95_ms: 0, max_ms: 0 };

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

    const [
      jobCounts,
      liveServices,
      heartbeatAges,
      jobDurations,
      outboxCounts,
      projectCounts,
      lore,
      quest,
      party,
    ] = await Promise.all([
      jobs.counts(pool),
      services.countLive(pool),
      services.heartbeatAges(pool),
      jobs.durationStats(pool, new Date(Date.now() - LATENCY_WINDOW_MS)),
      outbox.counts(pool),
      projects.countByStatus(pool),
      contributors.lore?.() ?? Promise.resolve({ entries: 0, stale: 0 }),
      contributors.quest?.() ?? Promise.resolve({ open: 0, blocked: 0 }),
      contributors.party?.() ?? Promise.resolve({ activeAgentRuns: 0, activeClaims: 0 }),
    ]);

    const local = metrics.snapshot();
    const byJobType = new Map(jobDurations.map((row) => [row.jobType, row]));

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
      http: {
        since: local.since,
        requests: metrics.counter(METRIC.httpRequests),
        duration: toLatency(metrics.latency(METRIC.httpRequestDuration)),
        errors_by_code: errorsByCode(local.counters),
      },
      latency: {
        lore_publish: toLatency(metrics.latency(METRIC.lorePublish)),
        lore_search: toLatency(metrics.latency(METRIC.loreSearch)),
        context_build: toLatency(metrics.latency(METRIC.contextBuild)),
        memory_validation: fromJob(byJobType.get('memory_validation')),
        context_snapshot: fromJob(byJobType.get('context_snapshot')),
        embedding: fromJob(byJobType.get('embedding')),
      },
      search: {
        total: metrics.counter(METRIC.loreSearchTotal),
        vector_fallback: metrics.counter(METRIC.loreSearchVectorFallback),
      },
      context: {
        builds: metrics.counter(METRIC.contextBuilds),
        tokens_total: metrics.counter(METRIC.contextTokens),
      },
      heartbeat_age_seconds: {
        api: round(heartbeatAges.api),
        worker: round(heartbeatAges.worker),
        scheduler: round(heartbeatAges.scheduler),
      },
    };
  }
}

function toLatency(snapshot: LatencySnapshot): LatencyDto {
  return {
    count: snapshot.count,
    mean_ms: snapshot.mean_ms,
    p95_ms: snapshot.p95_ms,
    max_ms: snapshot.max_ms,
  };
}

function fromJob(stats: JobDurationStats | undefined): LatencyDto {
  if (stats === undefined) return EMPTY_LATENCY;
  return { count: stats.count, mean_ms: stats.meanMs, p95_ms: stats.p95Ms, max_ms: stats.maxMs };
}

function errorsByCode(counters: Record<string, number>): Record<string, number> {
  const errors: Record<string, number> = {};
  for (const [name, value] of Object.entries(counters)) {
    if (!name.startsWith(METRIC.httpErrorPrefix)) continue;
    errors[name.slice(METRIC.httpErrorPrefix.length)] = value;
  }
  return errors;
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}
