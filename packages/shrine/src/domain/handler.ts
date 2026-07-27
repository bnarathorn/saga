import type { JobType } from '@saga/contracts';
import type { SagaLogger } from '@saga/shared/logging';
import type { ClaimedJob } from './job.js';

export interface JobHandlerContext {
  job: ClaimedJob;
  logger: SagaLogger;
  /** Aborted when the worker begins shutting down. Long handlers should check it. */
  signal: AbortSignal;
  /** Extend the lease during long work. Returns false once the claim has been lost. */
  renewLease(): Promise<boolean>;
}

/**
 * Every handler must be idempotent: delivery is at-least-once, and a recovered lease can
 * cause the same job to run twice.
 */
export interface JobHandler {
  readonly type: JobType;
  /** Documented contract for `docs/operations.md`. */
  readonly describe: {
    input: string;
    idempotency: string;
    retryPolicy: string;
    sideEffects: string;
    result: string;
    failureCodes: string[];
  };
  handle(context: JobHandlerContext): Promise<Record<string, unknown>>;
}

export class JobHandlerRegistry {
  private readonly handlers = new Map<JobType, JobHandler>();

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`A handler for job type "${handler.type}" is already registered.`);
    }
    this.handlers.set(handler.type, handler);
  }

  get(type: JobType): JobHandler | undefined {
    return this.handlers.get(type);
  }

  types(): JobType[] {
    return [...this.handlers.keys()].sort();
  }

  all(): JobHandler[] {
    return [...this.handlers.values()];
  }
}
