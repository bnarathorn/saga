/**
 * Process-local metrics.
 *
 * Saga's cross-process numbers (queue depth, leases, entry counts) come from PostgreSQL, and
 * anything derived from a job row is timed from `shrine.jobs`. What is left is work that only
 * the process doing it can see: how long an HTTP request took, how long a publish transaction
 * held, whether a search fell back to text-only. Those are recorded here and reported by the
 * instance that observed them.
 *
 * Deliberately not a Prometheus client: one registry, bounded memory, no scrape protocol.
 * Values reset when the process restarts, which the summary makes explicit via `since`.
 */

/** Ring size per series. 256 samples keep p95 meaningful without unbounded growth. */
const SAMPLE_CAPACITY = 256;

export interface LatencySnapshot {
  count: number;
  /** Mean over every observation since process start, not just the retained samples. */
  mean_ms: number;
  p95_ms: number;
  max_ms: number;
}

class LatencySeries {
  private readonly samples: number[] = [];
  private cursor = 0;
  private count = 0;
  private total = 0;
  private max = 0;

  observe(durationMs: number): void {
    this.count += 1;
    this.total += durationMs;
    if (durationMs > this.max) this.max = durationMs;

    if (this.samples.length < SAMPLE_CAPACITY) {
      this.samples.push(durationMs);
      return;
    }
    this.samples[this.cursor] = durationMs;
    this.cursor = (this.cursor + 1) % SAMPLE_CAPACITY;
  }

  snapshot(): LatencySnapshot {
    if (this.count === 0) return { count: 0, mean_ms: 0, p95_ms: 0, max_ms: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    // Nearest-rank p95 over the retained window.
    const rank = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return {
      count: this.count,
      mean_ms: round(this.total / this.count),
      p95_ms: round(sorted[Math.max(0, rank)] ?? 0),
      max_ms: round(this.max),
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface MetricsSnapshot {
  since: string;
  counters: Record<string, number>;
  latencies: Record<string, LatencySnapshot>;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly latencies = new Map<string, LatencySeries>();
  private since = new Date();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, durationMs: number): void {
    let series = this.latencies.get(name);
    if (series === undefined) {
      series = new LatencySeries();
      this.latencies.set(name, series);
    }
    series.observe(durationMs);
  }

  /** Time an operation and record it under `name`, whether it resolves or throws. */
  async time<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.observe(name, performance.now() - startedAt);
    }
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  latency(name: string): LatencySnapshot {
    return this.latencies.get(name)?.snapshot() ?? { count: 0, mean_ms: 0, p95_ms: 0, max_ms: 0 };
  }

  snapshot(): MetricsSnapshot {
    return {
      since: this.since.toISOString(),
      counters: Object.fromEntries([...this.counters.entries()].sort()),
      latencies: Object.fromEntries(
        [...this.latencies.entries()].sort().map(([name, series]) => [name, series.snapshot()]),
      ),
    };
  }

  /** Tests only: start from a clean registry. */
  reset(): void {
    this.counters.clear();
    this.latencies.clear();
    this.since = new Date();
  }
}

/** Metric names used across packages. Keeping them here stops silent typos between recorder
 *  and reader. */
export const METRIC = {
  httpRequests: 'http.requests',
  httpRequestDuration: 'http.request',
  /** Suffixed with the stable error code: `http.errors.QUEST_REVISION_CONFLICT`. */
  httpErrorPrefix: 'http.errors.',
  lorePublish: 'lore.publish',
  loreSearch: 'lore.search',
  loreSearchVectorFallback: 'lore.search.vector_fallback',
  loreSearchTotal: 'lore.search.total',
  contextBuild: 'context.build',
  contextTokens: 'context.tokens_total',
  contextBuilds: 'context.builds',
} as const;

/** The one registry per process. */
export const metrics = new MetricsRegistry();
