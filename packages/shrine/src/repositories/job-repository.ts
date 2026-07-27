import type { Queryable } from '@saga/database';
import type { JobState, JobType } from '@saga/contracts';
import type { ClaimedJob, EnqueueJobInput, Job } from '../domain/job.js';

interface JobRow {
  id: string;
  project_id: string | null;
  job_type: string;
  entity_type: string | null;
  entity_id: string | null;
  dedupe_key: string | null;
  state: string;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  claimed_by: string | null;
  claim_token: string | null;
  claimed_at: Date | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const COLUMNS = `id, project_id, job_type, entity_type, entity_id, dedupe_key, state, priority,
                 payload, result, attempts, max_attempts, run_after, claimed_by, claim_token,
                 claimed_at, lease_expires_at, last_error, correlation_id, created_at,
                 updated_at, completed_at`;

const PREFIXED = (alias: string) =>
  COLUMNS.split(',')
    .map((column) => `${alias}.${column.trim()}`)
    .join(', ');

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    projectId: row.project_id,
    jobType: row.job_type as JobType,
    entityType: row.entity_type,
    entityId: row.entity_id,
    dedupeKey: row.dedupe_key,
    state: row.state as JobState,
    priority: row.priority,
    payload: row.payload,
    result: row.result,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface JobCounts {
  queued: number;
  claimed: number;
  retrying: number;
  failed: number;
  succeededLastHour: number;
  oldestQueuedAgeSeconds: number | null;
}

export interface JobRepository {
  enqueue(q: Queryable, input: EnqueueJobInput): Promise<Job | null>;
  findById(q: Queryable, id: string): Promise<Job | null>;
  list(
    q: Queryable,
    filter: {
      state?: JobState;
      jobType?: JobType;
      projectId?: string;
      cursorKey?: string;
      cursorId?: string;
      limit: number;
    },
  ): Promise<Job[]>;
  claimBatch(
    q: Queryable,
    input: { workerId: string; leaseSeconds: number; limit: number; jobTypes?: readonly JobType[] },
  ): Promise<ClaimedJob[]>;
  renewLease(q: Queryable, id: string, claimToken: string, leaseSeconds: number): Promise<boolean>;
  succeed(
    q: Queryable,
    id: string,
    claimToken: string,
    result: Record<string, unknown>,
  ): Promise<boolean>;
  retry(
    q: Queryable,
    id: string,
    claimToken: string,
    error: string,
    runAfter: Date,
  ): Promise<boolean>;
  fail(q: Queryable, id: string, claimToken: string, error: string): Promise<boolean>;
  recoverExpiredLeases(q: Queryable): Promise<string[]>;
  adminRetry(q: Queryable, id: string): Promise<Job | null>;
  adminCancel(q: Queryable, id: string): Promise<Job | null>;
  adminRequeue(q: Queryable, id: string): Promise<Job | null>;
  counts(q: Queryable): Promise<JobCounts>;
  countFailedByProject(q: Queryable, projectIds: readonly string[]): Promise<Map<string, number>>;
  deleteFinishedBefore(q: Queryable, before: Date): Promise<number>;
}

export class PgJobRepository implements JobRepository {
  /**
   * Returns `null` when an identical job is already outstanding under the same dedupe key.
   *
   * `ON CONFLICT DO NOTHING` rather than catching the unique violation: enqueue is called
   * *inside* domain transactions, and in PostgreSQL a raised constraint violation aborts the
   * whole transaction. Catching it in JavaScript does not un-abort it, so the caller's
   * domain mutation would be silently rolled back at COMMIT.
   */
  async enqueue(q: Queryable, input: EnqueueJobInput): Promise<Job | null> {
    const result = await q.query<JobRow>(
      `INSERT INTO shrine.jobs
         (project_id, job_type, entity_type, entity_id, dedupe_key, priority, payload,
          max_attempts, run_after, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, COALESCE($9, now()), $10)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.projectId ?? null,
        input.jobType,
        input.entityType ?? null,
        input.entityId ?? null,
        input.dedupeKey ?? null,
        input.priority ?? 0,
        JSON.stringify(input.payload),
        input.maxAttempts ?? 5,
        input.runAfter ?? null,
        input.correlationId ?? null,
      ],
    );
    return result.rows[0] === undefined ? null : toJob(result.rows[0]);
  }

  async findById(q: Queryable, id: string): Promise<Job | null> {
    const result = await q.query<JobRow>(`SELECT ${COLUMNS} FROM shrine.jobs WHERE id = $1`, [id]);
    return result.rows[0] === undefined ? null : toJob(result.rows[0]);
  }

  async list(
    q: Queryable,
    filter: {
      state?: JobState;
      jobType?: JobType;
      projectId?: string;
      cursorKey?: string;
      cursorId?: string;
      limit: number;
    },
  ): Promise<Job[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.state !== undefined) {
      values.push(filter.state);
      conditions.push(`state = $${values.length}`);
    }
    if (filter.jobType !== undefined) {
      values.push(filter.jobType);
      conditions.push(`job_type = $${values.length}`);
    }
    if (filter.projectId !== undefined) {
      values.push(filter.projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    if (filter.cursorKey !== undefined && filter.cursorId !== undefined) {
      values.push(filter.cursorKey, filter.cursorId);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
    }

    values.push(filter.limit);
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const result = await q.query<JobRow>(
      `SELECT ${COLUMNS} FROM shrine.jobs ${where}
        ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(toJob);
  }

  /**
   * Claim eligible jobs. `FOR UPDATE SKIP LOCKED` lets N workers drain the queue without
   * contending, and each claimed row receives its **own** freshly generated claim token so a
   * worker that later loses its lease cannot complete the replacement worker's attempt.
   */
  async claimBatch(
    q: Queryable,
    input: { workerId: string; leaseSeconds: number; limit: number; jobTypes?: readonly JobType[] },
  ): Promise<ClaimedJob[]> {
    const types = input.jobTypes === undefined ? null : [...input.jobTypes];
    const result = await q.query<JobRow>(
      `WITH claimable AS (
         SELECT id FROM shrine.jobs
          WHERE state IN ('queued', 'retrying')
            AND run_after <= now()
            AND ($4::text[] IS NULL OR job_type = ANY($4::text[]))
          ORDER BY priority DESC, run_after, created_at
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE shrine.jobs j
            SET state = 'claimed',
                claimed_by = $1,
                claim_token = 'clm_' || replace(gen_random_uuid()::text, '-', ''),
                claimed_at = now(),
                lease_expires_at = now() + make_interval(secs => $2::double precision),
                attempts = j.attempts + 1,
                updated_at = now()
           FROM claimable
          WHERE j.id = claimable.id
        RETURNING ${PREFIXED('j')}
       )
       -- RETURNING row order is unspecified, so the batch is re-sorted here: a worker must
       -- still start the highest-priority job first within a single claim.
       SELECT * FROM claimed ORDER BY priority DESC, run_after, created_at`,
      [input.workerId, input.leaseSeconds, input.limit, types],
    );
    return result.rows.map((row) => toJob(row) as ClaimedJob);
  }

  async renewLease(
    q: Queryable,
    id: string,
    claimToken: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await q.query(
      `UPDATE shrine.jobs
          SET lease_expires_at = now() + make_interval(secs => $3::double precision),
              updated_at = now()
        WHERE id = $1 AND claim_token = $2 AND state = 'claimed'`,
      [id, claimToken, leaseSeconds],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async succeed(
    q: Queryable,
    id: string,
    claimToken: string,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    const updated = await q.query(
      `UPDATE shrine.jobs
          SET state = 'succeeded', result = $3::jsonb, completed_at = now(), updated_at = now(),
              claim_token = NULL, lease_expires_at = NULL, last_error = NULL
        WHERE id = $1 AND claim_token = $2 AND state = 'claimed'`,
      [id, claimToken, JSON.stringify(result)],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  async retry(
    q: Queryable,
    id: string,
    claimToken: string,
    error: string,
    runAfter: Date,
  ): Promise<boolean> {
    const updated = await q.query(
      `UPDATE shrine.jobs
          SET state = 'retrying', last_error = $3, run_after = $4, updated_at = now(),
              claim_token = NULL, lease_expires_at = NULL, claimed_by = NULL
        WHERE id = $1 AND claim_token = $2 AND state = 'claimed'`,
      [id, claimToken, error, runAfter],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  async fail(q: Queryable, id: string, claimToken: string, error: string): Promise<boolean> {
    const updated = await q.query(
      `UPDATE shrine.jobs
          SET state = 'failed', last_error = $3, completed_at = now(), updated_at = now(),
              claim_token = NULL, lease_expires_at = NULL
        WHERE id = $1 AND claim_token = $2 AND state = 'claimed'`,
      [id, claimToken, error],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  /**
   * Recover jobs whose worker died holding the lease. Clearing `claim_token` is what makes the
   * dead worker's later `succeed`/`fail` call a no-op.
   */
  async recoverExpiredLeases(q: Queryable): Promise<string[]> {
    const result = await q.query<{ id: string }>(
      `UPDATE shrine.jobs
          SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retrying' END,
              claim_token = NULL,
              claimed_by = NULL,
              lease_expires_at = NULL,
              completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
              last_error = 'The worker lease expired before the job completed.',
              run_after = now(),
              updated_at = now()
        WHERE state = 'claimed' AND lease_expires_at < now()
       RETURNING id`,
    );
    return result.rows.map((row) => row.id);
  }

  async adminRetry(q: Queryable, id: string): Promise<Job | null> {
    const result = await q.query<JobRow>(
      `UPDATE shrine.jobs
          SET state = 'queued', run_after = now(), attempts = 0, last_error = NULL,
              claim_token = NULL, claimed_by = NULL, lease_expires_at = NULL,
              completed_at = NULL, updated_at = now()
        WHERE id = $1 AND state IN ('failed', 'cancelled')
       RETURNING ${COLUMNS}`,
      [id],
    );
    return result.rows[0] === undefined ? null : toJob(result.rows[0]);
  }

  async adminCancel(q: Queryable, id: string): Promise<Job | null> {
    const result = await q.query<JobRow>(
      `UPDATE shrine.jobs
          SET state = 'cancelled', completed_at = now(), updated_at = now(),
              claim_token = NULL, lease_expires_at = NULL
        WHERE id = $1 AND state IN ('queued', 'retrying')
       RETURNING ${COLUMNS}`,
      [id],
    );
    return result.rows[0] === undefined ? null : toJob(result.rows[0]);
  }

  /** Force a job whose lease expired back into the queue without waiting for the reaper. */
  async adminRequeue(q: Queryable, id: string): Promise<Job | null> {
    const result = await q.query<JobRow>(
      `UPDATE shrine.jobs
          SET state = 'queued', run_after = now(), claim_token = NULL, claimed_by = NULL,
              lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND state = 'claimed' AND lease_expires_at < now()
       RETURNING ${COLUMNS}`,
      [id],
    );
    return result.rows[0] === undefined ? null : toJob(result.rows[0]);
  }

  async counts(q: Queryable): Promise<JobCounts> {
    const result = await q.query<{
      queued: string;
      claimed: string;
      retrying: string;
      failed: string;
      succeeded_last_hour: string;
      oldest_queued_age: string | null;
    }>(
      `SELECT count(*) FILTER (WHERE state = 'queued')::text AS queued,
              count(*) FILTER (WHERE state = 'claimed')::text AS claimed,
              count(*) FILTER (WHERE state = 'retrying')::text AS retrying,
              count(*) FILTER (WHERE state = 'failed')::text AS failed,
              count(*) FILTER (WHERE state = 'succeeded' AND completed_at > now() - interval '1 hour')::text
                AS succeeded_last_hour,
              extract(epoch FROM now() - min(created_at)
                FILTER (WHERE state IN ('queued', 'retrying')))::text AS oldest_queued_age
         FROM shrine.jobs`,
    );
    const row = result.rows[0]!;
    return {
      queued: Number(row.queued),
      claimed: Number(row.claimed),
      retrying: Number(row.retrying),
      failed: Number(row.failed),
      succeededLastHour: Number(row.succeeded_last_hour),
      oldestQueuedAgeSeconds: row.oldest_queued_age === null ? null : Number(row.oldest_queued_age),
    };
  }

  async countFailedByProject(
    q: Queryable,
    projectIds: readonly string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (projectIds.length === 0) return map;
    const result = await q.query<{ project_id: string; count: string }>(
      `SELECT project_id, count(*)::text AS count FROM shrine.jobs
        WHERE state = 'failed' AND project_id = ANY($1::uuid[])
        GROUP BY project_id`,
      [projectIds],
    );
    for (const row of result.rows) map.set(row.project_id, Number(row.count));
    return map;
  }

  async deleteFinishedBefore(q: Queryable, before: Date): Promise<number> {
    const result = await q.query(
      `DELETE FROM shrine.jobs
        WHERE state IN ('succeeded', 'cancelled') AND completed_at < $1`,
      [before],
    );
    return result.rowCount ?? 0;
  }
}
