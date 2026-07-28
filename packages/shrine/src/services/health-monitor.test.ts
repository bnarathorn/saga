import type { HealthState } from '@saga/contracts';
import type { SagaPool } from '@saga/database';
import { createSilentLogger } from '@saga/shared/logging';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  NewSystemEvent,
  SystemEventRepository,
} from '../repositories/system-event-repository.js';
import { HealthMonitor } from './health-monitor.js';
import { HealthRegistry } from './health-service.js';

/** Collects what the monitor would have written, and replays it back as `latestOfType` would. */
function recordingEvents(seed: NewSystemEvent[] = []): {
  repo: SystemEventRepository;
  written: NewSystemEvent[];
} {
  const feed: NewSystemEvent[] = [...seed];
  const written: NewSystemEvent[] = [];
  const repo = {
    record: async (_q: unknown, event: NewSystemEvent) => {
      written.push(event);
      feed.push(event);
      return { ...event, id: 'x', sequence: feed.length } as never;
    },
    latestOfType: async (_q: unknown, eventType: string) => {
      const last = [...feed].reverse().find((event) => event.eventType === eventType);
      return last === undefined ? null : ({ ...last, id: 'x', sequence: feed.length } as never);
    },
  } as unknown as SystemEventRepository;
  return { repo, written };
}

function monitorFor(status: () => HealthState, seed: NewSystemEvent[] = []) {
  const health = new HealthRegistry();
  health.register({
    name: 'test',
    readiness: true,
    check: () => Promise.resolve({ status: status(), message: 'test check' }),
  });
  const { repo, written } = recordingEvents(seed);
  const monitor = new HealthMonitor({
    pool: {} as SagaPool,
    health,
    events: repo,
    logger: createSilentLogger(),
    intervalMs: 60_000,
  });
  return { monitor, written };
}

describe('health monitor', () => {
  let current: HealthState;

  beforeEach(() => {
    current = 'healthy';
  });

  it('records the first evaluation so the feed states the starting health', async () => {
    const { monitor, written } = monitorFor(() => current);
    await monitor.tick();

    expect(written).toHaveLength(1);
    expect(written[0]?.eventType).toBe('shrine.health_changed');
    expect(written[0]?.metadata?.from).toBeNull();
    expect(written[0]?.metadata?.to).toBe('healthy');
  });

  it('writes nothing while health is unchanged', async () => {
    const { monitor, written } = monitorFor(() => current);
    await monitor.tick();
    await monitor.tick();
    await monitor.tick();

    expect(written).toHaveLength(1);
  });

  it('records a transition in both directions', async () => {
    const { monitor, written } = monitorFor(() => current);
    await monitor.tick();

    current = 'degraded';
    await monitor.tick();
    current = 'healthy';
    await monitor.tick();

    expect(written.map((event) => event.metadata?.to)).toEqual(['healthy', 'degraded', 'healthy']);
    expect(written[1]?.severity).toBe('warning');
    expect(written[2]?.severity).toBe('info');
    expect(written[1]?.message).toContain('from healthy to degraded');
  });

  it('names the failing checks so the event is actionable on its own', async () => {
    const { monitor, written } = monitorFor(() => current);
    await monitor.tick();
    current = 'unhealthy';
    await monitor.tick();

    expect(written[1]?.severity).toBe('error');
    expect(written[1]?.metadata?.failing_checks).toEqual([
      { name: 'test', status: 'unhealthy', message: 'test check' },
    ]);
  });

  it('stays quiet after a restart when the feed already records this status', async () => {
    // A restarted process starts with no in-memory history; re-announcing `healthy` on every
    // deploy would turn a transition log into a restart log.
    const { monitor, written } = monitorFor(
      () => current,
      [
        {
          severity: 'info',
          category: 'shrine',
          eventType: 'shrine.health_changed',
          message: 'Shrine health is healthy.',
          metadata: { from: null, to: 'healthy' },
        },
      ],
    );

    await monitor.tick();
    expect(written).toHaveLength(0);
  });

  it('still reports a transition away from the recorded status after a restart', async () => {
    const { monitor, written } = monitorFor(
      () => current,
      [
        {
          severity: 'info',
          category: 'shrine',
          eventType: 'shrine.health_changed',
          message: 'Shrine health is healthy.',
          metadata: { from: null, to: 'healthy' },
        },
      ],
    );

    current = 'unhealthy';
    await monitor.tick();

    expect(written).toHaveLength(1);
    expect(written[0]?.metadata?.from).toBe('healthy');
    expect(written[0]?.metadata?.to).toBe('unhealthy');
  });

  it('survives a failing evaluation instead of throwing at the caller', async () => {
    const health = new HealthRegistry();
    health.register({
      name: 'broken',
      readiness: true,
      check: () => Promise.reject(new Error('database gone')),
    });
    const { repo } = recordingEvents();
    const monitor = new HealthMonitor({
      pool: {} as SagaPool,
      health,
      events: repo,
      logger: createSilentLogger(),
      intervalMs: 60_000,
    });

    // The registry turns a thrown check into `unhealthy`; nothing propagates out of tick().
    await expect(monitor.tick()).resolves.toBe('unhealthy');
  });
});
