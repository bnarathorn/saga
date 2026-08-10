import type { JobState, JobType } from '@saga/contracts';

export type { JobState, JobType };

export interface Job {
  id: string;
  projectId: string | null;
  jobType: JobType;
  entityType: string | null;
  entityId: string | null;
  dedupeKey: string | null;
  state: JobState;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  claimedBy: string | null;
  claimToken: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface EnqueueJobInput {
  projectId?: string | null;
  jobType: JobType;
  entityType?: string | null;
  entityId?: string | null;
  /**
   * Suppresses a duplicate while an identical job is still outstanding. A finished job never
   * blocks a future one — see the partial unique index `jobs_dedupe_active_uniq`.
   */
  dedupeKey?: string | null;
  priority?: number;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  runAfter?: Date;
  correlationId?: string | null;
}

/** A job plus the claim token that authorises the holder to complete it. */
export interface ClaimedJob extends Job {
  claimToken: string;
  leaseExpiresAt: Date;
}

/**
 * How a handler failure should be treated. A permanent failure skips remaining attempts
 * because retrying an invalid payload or a deleted entity can never succeed.
 */
export type JobFailureKind = 'retryable' | 'permanent';

export class JobHandlerError extends Error {
  readonly kind: JobFailureKind;
  readonly detail: Record<string, unknown>;
  /**
   * Floor on the delay before the next attempt, when the handler knows how long it is waiting
   * for. Absent for a real failure, which has no idea and takes the standard backoff.
   */
  readonly retryAfterMs?: number;
  /** True when nothing went wrong and the handler is only waiting for something else. */
  readonly waiting: boolean;

  constructor(
    kind: JobFailureKind,
    message: string,
    detail: Record<string, unknown> = {},
    options: { retryAfterMs?: number; waiting?: boolean } = {},
  ) {
    super(message);
    this.name = 'JobHandlerError';
    this.kind = kind;
    this.detail = detail;
    this.retryAfterMs = options.retryAfterMs;
    this.waiting = options.waiting ?? false;
  }

  static retryable(message: string, detail?: Record<string, unknown>): JobHandlerError {
    return new JobHandlerError('retryable', message, detail);
  }

  /**
   * Come back in `retryAfterMs`, because something this job depends on has not finished yet.
   *
   * Distinct from `retryable` in both halves of its behaviour, and both matter.
   *
   * The delay: the standard backoff starts at one second and doubles, which is right for a
   * dropped connection and useless for waiting on work measured in tens of seconds. A handler
   * that knows what it is waiting for should say so — `memory_validation` waited three attempts
   * for an embedding and got 2-3 seconds of wall clock for it, so in production it burned every
   * attempt and gave up, every single time, and the wait never once did what it was for.
   *
   * The name: a wait is not a failure. Logging it as one puts `job failed` in the log on the
   * happy path, which is how an operator learns to scroll past the line that matters.
   */
  static waiting(
    message: string,
    retryAfterMs: number,
    detail?: Record<string, unknown>,
  ): JobHandlerError {
    return new JobHandlerError('retryable', message, detail, { retryAfterMs, waiting: true });
  }

  static permanent(message: string, detail?: Record<string, unknown>): JobHandlerError {
    return new JobHandlerError('permanent', message, detail);
  }
}
