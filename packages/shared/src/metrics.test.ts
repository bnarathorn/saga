import { describe, expect, it } from 'vitest';
import { METRIC, MetricsRegistry } from './metrics.js';

describe('metrics registry', () => {
  it('counts and reports a counter by name', () => {
    const registry = new MetricsRegistry();
    registry.increment('http.requests');
    registry.increment('http.requests');
    registry.increment('http.requests', 5);

    expect(registry.counter('http.requests')).toBe(7);
    expect(registry.counter('never.touched')).toBe(0);
  });

  it('summarises a latency series', () => {
    const registry = new MetricsRegistry();
    for (const value of [10, 20, 30, 40]) registry.observe('op', value);

    const latency = registry.latency('op');
    expect(latency.count).toBe(4);
    expect(latency.mean_ms).toBe(25);
    expect(latency.max_ms).toBe(40);
    expect(latency.p95_ms).toBe(40);
  });

  it('reports zeroes for a series that has never been observed', () => {
    expect(new MetricsRegistry().latency('nothing')).toEqual({
      count: 0,
      mean_ms: 0,
      p95_ms: 0,
      max_ms: 0,
    });
  });

  it('keeps count and mean exact past the sample window, and bounds memory', () => {
    const registry = new MetricsRegistry();
    // 1000 observations against a 256-sample ring: the ring wraps, the totals do not.
    for (let i = 0; i < 1000; i += 1) registry.observe('op', 100);

    const latency = registry.latency('op');
    expect(latency.count).toBe(1000);
    expect(latency.mean_ms).toBe(100);
    expect(JSON.stringify(registry.snapshot()).length).toBeLessThan(1_000);
  });

  it('reports the tail, not the bulk, when outliers exceed 5%', () => {
    const registry = new MetricsRegistry();
    for (let i = 0; i < 90; i += 1) registry.observe('op', 1);
    for (let i = 0; i < 10; i += 1) registry.observe('op', 500);

    // Nearest rank: p95 is the smallest value at or above the 95th percentile position.
    expect(registry.latency('op').p95_ms).toBe(500);
    expect(registry.latency('op').mean_ms).toBeCloseTo(50.9, 1);
  });

  it('leaves p95 at the bulk when outliers stay under 5%', () => {
    const registry = new MetricsRegistry();
    for (let i = 0; i < 96; i += 1) registry.observe('op', 1);
    for (let i = 0; i < 4; i += 1) registry.observe('op', 500);

    expect(registry.latency('op').p95_ms).toBe(1);
    expect(registry.latency('op').max_ms).toBe(500);
  });

  it('records the duration of an operation that throws', async () => {
    const registry = new MetricsRegistry();
    await expect(registry.time('op', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );

    expect(registry.latency('op').count).toBe(1);
  });

  it('returns the value of a timed operation', async () => {
    const registry = new MetricsRegistry();
    await expect(registry.time('op', () => Promise.resolve(42))).resolves.toBe(42);
    expect(registry.latency('op').count).toBe(1);
  });

  it('snapshots counters and latencies with a start timestamp', () => {
    const registry = new MetricsRegistry();
    registry.increment(`${METRIC.httpErrorPrefix}NOT_FOUND`, 3);
    registry.observe(METRIC.httpRequestDuration, 12);

    const snapshot = registry.snapshot();
    expect(snapshot.counters[`${METRIC.httpErrorPrefix}NOT_FOUND`]).toBe(3);
    expect(snapshot.latencies[METRIC.httpRequestDuration]?.count).toBe(1);
    expect(() => new Date(snapshot.since).toISOString()).not.toThrow();
  });

  it('clears everything on reset', () => {
    const registry = new MetricsRegistry();
    registry.increment('a');
    registry.observe('b', 1);
    registry.reset();

    expect(registry.counter('a')).toBe(0);
    expect(registry.latency('b').count).toBe(0);
  });
});
