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

  constructor(kind: JobFailureKind, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'JobHandlerError';
    this.kind = kind;
    this.detail = detail;
  }

  static retryable(message: string, detail?: Record<string, unknown>): JobHandlerError {
    return new JobHandlerError('retryable', message, detail);
  }

  static permanent(message: string, detail?: Record<string, unknown>): JobHandlerError {
    return new JobHandlerError('permanent', message, detail);
  }
}
