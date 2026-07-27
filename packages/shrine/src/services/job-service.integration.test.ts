import type { SagaPool } from '@saga/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, createTestServices, truncateAll } from '../../../../testing/harness.js';
import type { ClaimedJob } from '../domain/job.js';
import type { JobService } from './job-service.js';
import { PgJobRepository } from '../repositories/job-repository.js';

let pool: SagaPool;
let jobs: JobService;
let services: ReturnType<typeof createTestServices>;
const repo = new PgJobRepository();

beforeEach(async () => {
  pool ??= createTestPool('saga-shrine-test');
  services ??= createTestServices({ pool });
  jobs = services.jobs;
  await truncateAll(pool);
});

afterAll(async () => {
  await pool?.end();
});

async function enqueueNoop(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await jobs.enqueue({ jobType: 'noop', payload: { index: i } });
  }
}

describe('job claiming', () => {
  it('gives each claimed job its own claim token', async () => {
    await enqueueNoop(3);
    const claimed = await jobs.claim({ workerId: crypto.randomUUID(), limit: 3 });
    expect(claimed).toHaveLength(3);
    const tokens = new Set(claimed.map((job) => job.claimToken));
    expect(tokens.size).toBe(3);
    for (const job of claimed) {
      expect(job.claimToken).toMatch(/^clm_[0-9a-f]{32}$/);
      expect(job.state).toBe('claimed');
      expect(job.attempts).toBe(1);
    }
  });

  it('never hands the same job to two workers', async () => {
    await enqueueNoop(20);
    // Two workers claiming at the same time must partition the queue, not duplicate it.
    const [a, b] = await Promise.all([
      jobs.claim({ workerId: crypto.randomUUID(), limit: 20 }),
      jobs.claim({ workerId: crypto.randomUUID(), limit: 20 }),
    ]);
    const ids = [...a, ...b].map((job) => job.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('respects priority then age', async () => {
    const low = await jobs.enqueue({ jobType: 'noop', payload: {}, priority: 0 });
    const high = await jobs.enqueue({ jobType: 'noop', payload: {}, priority: 10 });
    const claimed = await jobs.claim({ workerId: crypto.randomUUID(), limit: 2 });
    expect(claimed[0]?.id).toBe(high?.id);
    expect(claimed[1]?.id).toBe(low?.id);
  });

  it('does not claim a job whose run_after is in the future', async () => {
    await jobs.enqueue({
      jobType: 'noop',
      payload: {},
      runAfter: new Date(Date.now() + 60_000),
    });
    const claimed = await jobs.claim({ workerId: crypto.randomUUID(), limit: 5 });
    expect(claimed).toEqual([]);
  });

  it('only claims job types the worker can handle', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {} });
    await jobs.enqueue({ jobType: 'embedding', payload: {} });
    const claimed = await jobs.claim({ workerId: crypto.randomUUID(), limit: 5, jobTypes: ['noop'] });
    expect(claimed.map((job) => job.jobType)).toEqual(['noop']);
  });
});

describe('deduplication', () => {
  it('suppresses a duplicate while one is outstanding, then allows a new one', async () => {
    const first = await jobs.enqueue({ jobType: 'cleanup', payload: {}, dedupeKey: 'periodic' });
    const second = await jobs.enqueue({ jobType: 'cleanup', payload: {}, dedupeKey: 'periodic' });
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1 });
    await jobs.succeed(claimed!, {});

    // A finished job must not block the next scheduled run.
    const third = await jobs.enqueue({ jobType: 'cleanup', payload: {}, dedupeKey: 'periodic' });
    expect(third).not.toBeNull();
  });
});

describe('claim tokens', () => {
  it('rejects a completion from a worker whose claim was recovered', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {} });
    const [stale] = await jobs.claim({
      workerId: crypto.randomUUID(),
      limit: 1,
      leaseSeconds: -1, // Already expired: simulates a worker that hung past its lease.
    });
    expect(stale).toBeDefined();

    const recovered = await jobs.recoverExpiredLeases();
    expect(recovered).toContain(stale!.id);

    // A replacement worker picks the job up and gets a different token.
    const [replacement] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1 });
    expect(replacement!.id).toBe(stale!.id);
    expect(replacement!.claimToken).not.toBe(stale!.claimToken);

    // The late worker's result must be refused, not silently written over the new attempt.
    await expect(jobs.succeed(stale!, { late: true })).rejects.toMatchObject({
      code: 'JOB_CLAIM_LOST',
    });

    await jobs.succeed(replacement!, { winner: true });
    const final = await jobs.get(stale!.id);
    expect(final.state).toBe('succeeded');
    expect(final.result).toEqual({ winner: true });
  });

  it('refuses to renew a lease with an obsolete token', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {} });
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1, leaseSeconds: -1 });
    await jobs.recoverExpiredLeases();
    expect(await jobs.renewLease(claimed!)).toBe(false);
  });

  it('renews a live lease', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {} });
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1, leaseSeconds: 5 });
    const before = claimed!.leaseExpiresAt.getTime();
    expect(await jobs.renewLease(claimed!, 300)).toBe(true);
    const after = await jobs.get(claimed!.id);
    expect(after.leaseExpiresAt!.getTime()).toBeGreaterThan(before);
  });
});

describe('lease recovery', () => {
  it('marks a recovered job failed once its attempts are exhausted', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {}, maxAttempts: 1 });
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1, leaseSeconds: -1 });
    await jobs.recoverExpiredLeases();
    const job = await jobs.get(claimed!.id);
    expect(job.state).toBe('failed');
    expect(job.lastError).toMatch(/lease expired/);
  });

  it('requeues a recovered job that still has attempts left', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {}, maxAttempts: 5 });
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1, leaseSeconds: -1 });
    await jobs.recoverExpiredLeases();
    const job = await jobs.get(claimed!.id);
    expect(job.state).toBe('retrying');
    expect(job.claimToken).toBeNull();
  });

  it('leaves a live claim alone', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {} });
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1, leaseSeconds: 300 });
    expect(await jobs.recoverExpiredLeases()).not.toContain(claimed!.id);
    expect((await jobs.get(claimed!.id)).state).toBe('claimed');
  });
});

describe('failure handling', () => {
  it('schedules a retry with backoff for a retryable failure', async () => {
    const enqueued = await jobs.enqueue({ jobType: 'noop', payload: {}, maxAttempts: 3 });
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1 });
    const outcome = await jobs.recordFailure(claimed!, 'provider timeout', 'retryable');
    expect(outcome).toBe('retrying');

    const job = await jobs.get(enqueued!.id);
    expect(job.state).toBe('retrying');
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(job.lastError).toBe('provider timeout');
  });

  it('fails immediately on a permanent error, whatever the attempt count', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {}, maxAttempts: 5 });
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1 });
    expect(await jobs.recordFailure(claimed!, 'invalid payload', 'permanent')).toBe('failed');
    expect((await jobs.get(claimed!.id)).state).toBe('failed');
  });

  it('gives up once attempts reach max_attempts', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {}, maxAttempts: 2 });

    let job: ClaimedJob | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      [job] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1 });
      if (job === undefined) break;
      await repo.retry(pool, job.id, job.claimToken, 'transient', new Date(Date.now() - 1_000));
    }
    [job] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1 });
    expect(job!.attempts).toBe(3);
    expect(await jobs.recordFailure(job!, 'still failing', 'retryable')).toBe('failed');
  });

  it('records a system event when a job fails permanently', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {} });
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1 });
    await jobs.recordFailure(claimed!, 'bad payload', 'permanent');
    const events = await pool.query<{ event_type: string; severity: string }>(
      `SELECT event_type, severity FROM shrine.system_events WHERE entity_id = $1`,
      [claimed!.id],
    );
    expect(events.rows[0]).toMatchObject({ event_type: 'shrine.job_failed', severity: 'error' });
  });
});

describe('operator actions', () => {
  it('retries a failed job and resets its attempts', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {} });
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1 });
    await jobs.recordFailure(claimed!, 'boom', 'permanent');

    const retried = await jobs.adminRetry(claimed!.id, 'admin@example.test', 'operator retry');
    expect(retried.state).toBe('queued');
    expect(retried.attempts).toBe(0);
    expect(retried.lastError).toBeNull();
  });

  it('refuses to retry a job that is not in a terminal state', async () => {
    const enqueued = await jobs.enqueue({ jobType: 'noop', payload: {} });
    await expect(jobs.adminRetry(enqueued!.id, 'admin', 'why not')).rejects.toMatchObject({
      code: 'JOB_STATE_INVALID',
    });
  });

  it('cancels a queued job', async () => {
    const enqueued = await jobs.enqueue({ jobType: 'noop', payload: {} });
    const cancelled = await jobs.adminCancel(enqueued!.id, 'admin', 'no longer needed');
    expect(cancelled.state).toBe('cancelled');
    expect(await jobs.claim({ workerId: crypto.randomUUID(), limit: 5 })).toEqual([]);
  });

  it('requeues only a claimed job whose lease already expired', async () => {
    await jobs.enqueue({ jobType: 'noop', payload: {} });
    const [live] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1, leaseSeconds: 300 });
    await expect(jobs.adminRequeue(live!.id, 'admin', 'stuck?')).rejects.toMatchObject({
      code: 'JOB_STATE_INVALID',
    });

    await jobs.enqueue({ jobType: 'noop', payload: {} });
    const [expired] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1, leaseSeconds: -1 });
    const requeued = await jobs.adminRequeue(expired!.id, 'admin', 'lease expired');
    expect(requeued.state).toBe('queued');
  });

  it('reports counts used by Shrine', async () => {
    await enqueueNoop(3);
    const [claimed] = await jobs.claim({ workerId: crypto.randomUUID(), limit: 1 });
    await jobs.recordFailure(claimed!, 'boom', 'permanent');
    const counts = await jobs.counts();
    expect(counts.queued).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.oldestQueuedAgeSeconds).toBeGreaterThanOrEqual(0);
  });
});
