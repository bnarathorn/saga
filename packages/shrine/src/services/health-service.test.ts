import { describe, expect, it } from 'vitest';
import { HealthRegistry, worstStatus, type HealthContributor } from './health-service.js';

/**
 * The health model (spec 15.1).
 *
 * `unknown` exists in the state enum and in the severity ordering, and until this suite was
 * written nothing produced it: a check that never answered was reported as `unhealthy`, which
 * asserts the dependency is broken when all that is known is that nobody answered.
 */

function contributor(overrides: Partial<HealthContributor> & { name: string }): HealthContributor {
  return {
    readiness: false,
    check: async () => ({ name: overrides.name, status: 'healthy', message: 'ok' }),
    ...overrides,
  };
}

describe('worstStatus', () => {
  it('orders healthy < unknown < degraded < unhealthy', () => {
    expect(worstStatus(['healthy', 'unknown'])).toBe('unknown');
    expect(worstStatus(['unknown', 'degraded'])).toBe('degraded');
    expect(worstStatus(['degraded', 'unhealthy'])).toBe('unhealthy');
    expect(worstStatus([])).toBe('healthy');
  });
});

describe('HealthRegistry', () => {
  it('reports a check that never answers as unknown, not as unhealthy', async () => {
    const registry = new HealthRegistry(20);
    registry.register(contributor({ name: 'slow', check: () => new Promise(() => {}) }));

    const report = await registry.run();

    expect(report.checks[0]).toMatchObject({ name: 'slow', status: 'unknown' });
    expect(report.checks[0]?.message).toMatch(/did not answer/);
    expect(report.status).toBe('unknown');
  });

  it('still reports a thrown check as unhealthy, because that is evidence', async () => {
    const registry = new HealthRegistry(50);
    registry.register(
      contributor({
        name: 'database',
        check: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );

    const report = await registry.run();

    expect(report.checks[0]).toMatchObject({ name: 'database', status: 'unhealthy' });
    expect(report.checks[0]?.message).toContain('ECONNREFUSED');
  });

  it('does not let one hung contributor hold up the others', async () => {
    const registry = new HealthRegistry(30);
    registry.register(contributor({ name: 'hung', check: () => new Promise(() => {}) }));
    registry.register(contributor({ name: 'fast' }));

    const report = await registry.run();

    expect(report.checks.map((check) => check.name)).toEqual(['fast', 'hung']);
    expect(report.checks.find((check) => check.name === 'fast')?.status).toBe('healthy');
  });

  it('keeps the registered name even when a check reports a different one', async () => {
    const registry = new HealthRegistry(50);
    registry.register(
      contributor({
        name: 'embeddings',
        check: async () => ({ name: 'something-else', status: 'degraded', message: 'slow' }),
      }),
    );

    const report = await registry.run();
    expect(report.checks[0]?.name).toBe('embeddings');
  });

  it('runs only readiness contributors when asked for readiness', async () => {
    const registry = new HealthRegistry(50);
    registry.register(contributor({ name: 'database', readiness: true }));
    registry.register(contributor({ name: 'embeddings', readiness: false }));

    const report = await registry.run('readiness');
    expect(report.checks.map((check) => check.name)).toEqual(['database']);
  });

  it('sorts checks by name so the report is stable', async () => {
    const registry = new HealthRegistry(50);
    for (const name of ['workers', 'database', 'job_queue']) {
      registry.register(contributor({ name }));
    }

    const report = await registry.run();
    expect(report.checks.map((check) => check.name)).toEqual(['database', 'job_queue', 'workers']);
  });

  it('records how long each check took', async () => {
    const registry = new HealthRegistry(50);
    registry.register(contributor({ name: 'database' }));

    const report = await registry.run();
    expect(report.checks[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
