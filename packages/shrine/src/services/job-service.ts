import type { JobState, JobType } from '@saga/contracts';
import type { Queryable, SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import { SagaError, buildPage, decodeCursor, nextRetryAt, type Page } from '@saga/shared';
import type { ClaimedJob, EnqueueJobInput, Job } from '../domain/job.js';
import type { JobCounts, JobRepository } from '../repositories/job-repository.js';
import type { SystemEventRepository } from '../repositories/system-event-repository.js';

export interface JobServiceDeps {
  pool: SagaPool;
  jobs: JobRepository;
  events: SystemEventRepository;
  jobLeaseSeconds: number;
  jobMaxAttempts: number;
}

export interface ClaimOptions {
  workerId: string;
  limit: number;
  jobTypes?: readonly JobType[];
  leaseSeconds?: number;
}

export class JobService {
  constructor(private readonly deps: JobServiceDeps) {}

  /**
   * Enqueue on an existing transaction so a job is only visible if the mutation that needs it
   * committed. Returns `null` when deduplicated.
   */
  async enqueueIn(tx: Queryable, input: EnqueueJobInput): Promise<Job | null> {
    return this.deps.jobs.enqueue(tx, {
      maxAttempts: this.deps.jobMaxAttempts,
      ...input,
    });
  }

  async enqueue(input: EnqueueJobInput): Promise<Job | null> {
    return withTransaction(this.deps.pool, (tx) => this.enqueueIn(tx, input));
  }

  async get(id: string): Promise<Job> {
    const job = await this.deps.jobs.findById(this.deps.pool, id);
    if (job === null) {
      throw new SagaError('JOB_NOT_FOUND', 'No job matches that id.', { details: { job_id: id } });
    }
    return job;
  }

  async list(filter: {
    state?: JobState;
    jobType?: JobType;
    projectId?: string;
    cursor?: string;
    limit: number;
  }): Promise<Page<Job>> {
    const cursor = filter.cursor === undefined ? null : decodeCursor(filter.cursor);
    const rows = await this.deps.jobs.list(this.deps.pool, {
      state: filter.state,
      jobType: filter.jobType,
      projectId: filter.projectId,
      cursorKey: cursor?.k,
      cursorId: cursor?.id,
      limit: filter.limit + 1,
    });
    return buildPage(rows, filter.limit, (job) => ({
      k: job.createdAt.toISOString(),
      id: job.id,
    }));
  }

  async claim(options: ClaimOptions): Promise<ClaimedJob[]> {
    return withTransaction(this.deps.pool, (tx) =>
      this.deps.jobs.claimBatch(tx, {
        workerId: options.workerId,
        leaseSeconds: options.leaseSeconds ?? this.deps.jobLeaseSeconds,
        limit: options.limit,
        jobTypes: options.jobTypes,
      }),
    );
  }

  async renewLease(job: ClaimedJob, leaseSeconds?: number): Promise<boolean> {
    return this.deps.jobs.renewLease(
      this.deps.pool,
      job.id,
      job.claimToken,
      leaseSeconds ?? this.deps.jobLeaseSeconds,
    );
  }

  /**
   * Completion is authorised by the claim token. A worker whose lease was recovered while it
   * was still running finds its token cleared and gets `JOB_CLAIM_LOST` instead of silently
   * overwriting the replacement worker's result.
   */
  async succeed(job: ClaimedJob, result: Record<string, unknown>): Promise<void> {
    const ok = await this.deps.jobs.succeed(this.deps.pool, job.id, job.claimToken, result);
    if (!ok) {
      throw new SagaError(
        'JOB_CLAIM_LOST',
        'This job was reclaimed by another worker; the result was discarded.',
        { details: { job_id: job.id } },
      );
    }
  }

  /** Decide between another attempt and a terminal failure, then record the outcome. */
  async recordFailure(
    job: ClaimedJob,
    error: string,
    kind: 'retryable' | 'permanent',
    now: Date = new Date(),
  ): Promise<'retrying' | 'failed'> {
    const exhausted = job.attempts >= job.maxAttempts;
    if (kind === 'permanent' || exhausted) {
      const ok = await this.deps.jobs.fail(this.deps.pool, job.id, job.claimToken, error);
      if (!ok) {
        throw new SagaError('JOB_CLAIM_LOST', 'This job was reclaimed by another worker.', {
          details: { job_id: job.id },
        });
      }
      await this.deps.events.record(this.deps.pool, {
        severity: 'error',
        category: 'job',
        projectId: job.projectId,
        entityType: 'job',
        entityId: job.id,
        eventType: 'shrine.job_failed',
        message: `Job ${job.jobType} failed permanently after ${job.attempts} attempt(s).`,
        metadata: { job_type: job.jobType, attempts: job.attempts, reason: kind },
      });
      return 'failed';
    }

    const runAfter = nextRetryAt(now, job.attempts);
    const ok = await this.deps.jobs.retry(this.deps.pool, job.id, job.claimToken, error, runAfter);
    if (!ok) {
      throw new SagaError('JOB_CLAIM_LOST', 'This job was reclaimed by another worker.', {
        details: { job_id: job.id },
      });
    }
    return 'retrying';
  }

  /** Reap jobs whose worker died. Called periodically by the worker's maintenance loop. */
  async recoverExpiredLeases(): Promise<string[]> {
    const ids = await this.deps.jobs.recoverExpiredLeases(this.deps.pool);
    if (ids.length > 0) {
      await this.deps.events.record(this.deps.pool, {
        severity: 'warning',
        category: 'job',
        eventType: 'shrine.job_lease_recovered',
        message: `Recovered ${ids.length} job(s) whose worker lease expired.`,
        metadata: { job_ids: ids.slice(0, 20), count: ids.length },
      });
    }
    return ids;
  }

  async adminRetry(id: string, actor: string, reason: string): Promise<Job> {
    const job = await this.deps.jobs.adminRetry(this.deps.pool, id);
    if (job === null) {
      const existing = await this.deps.jobs.findById(this.deps.pool, id);
      if (existing === null) {
        throw new SagaError('JOB_NOT_FOUND', 'No job matches that id.', {
          details: { job_id: id },
        });
      }
      throw new SagaError(
        'JOB_STATE_INVALID',
        `Only failed or cancelled jobs can be retried; this job is ${existing.state}.`,
        { details: { job_id: id, state: existing.state } },
      );
    }
    await this.deps.events.record(this.deps.pool, {
      severity: 'info',
      category: 'job',
      projectId: job.projectId,
      entityType: 'job',
      entityId: job.id,
      eventType: 'shrine.job_state_changed',
      message: `Job ${job.jobType} was retried by ${actor}.`,
      metadata: { action: 'retry', actor, reason, job_type: job.jobType },
    });
    return job;
  }

  async adminCancel(id: string, actor: string, reason: string): Promise<Job> {
    const job = await this.deps.jobs.adminCancel(this.deps.pool, id);
    if (job === null) {
      const existing = await this.deps.jobs.findById(this.deps.pool, id);
      if (existing === null) {
        throw new SagaError('JOB_NOT_FOUND', 'No job matches that id.', {
          details: { job_id: id },
        });
      }
      throw new SagaError(
        'JOB_STATE_INVALID',
        `Only queued or retrying jobs can be cancelled; this job is ${existing.state}.`,
        { details: { job_id: id, state: existing.state } },
      );
    }
    await this.deps.events.record(this.deps.pool, {
      severity: 'info',
      category: 'job',
      projectId: job.projectId,
      entityType: 'job',
      entityId: job.id,
      eventType: 'shrine.job_state_changed',
      message: `Job ${job.jobType} was cancelled by ${actor}.`,
      metadata: { action: 'cancel', actor, reason, job_type: job.jobType },
    });
    return job;
  }

  async adminRequeue(id: string, actor: string, reason: string): Promise<Job> {
    const job = await this.deps.jobs.adminRequeue(this.deps.pool, id);
    if (job === null) {
      const existing = await this.deps.jobs.findById(this.deps.pool, id);
      if (existing === null) {
        throw new SagaError('JOB_NOT_FOUND', 'No job matches that id.', {
          details: { job_id: id },
        });
      }
      throw new SagaError(
        'JOB_STATE_INVALID',
        'Only a claimed job whose lease has already expired can be requeued.',
        { details: { job_id: id, state: existing.state } },
      );
    }
    await this.deps.events.record(this.deps.pool, {
      severity: 'info',
      category: 'job',
      projectId: job.projectId,
      entityType: 'job',
      entityId: job.id,
      eventType: 'shrine.job_state_changed',
      message: `Job ${job.jobType} was requeued by ${actor}.`,
      metadata: { action: 'requeue', actor, reason, job_type: job.jobType },
    });
    return job;
  }

  async counts(): Promise<JobCounts> {
    return this.deps.jobs.counts(this.deps.pool);
  }
}
