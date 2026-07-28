import { hostname } from 'node:os';
import type { ClaimedJob, JobHandlerRegistry, JobService } from '@saga/shrine';
import { JobHandlerError } from '@saga/shrine';
import type { ServiceInstanceRepository } from '@saga/shrine';
import type { SagaPool } from '@saga/database';
import { errorMessage, isSagaError, sleep } from '@saga/shared';
import { newUuid } from '@saga/shared/ids';
import type { SagaLogger } from '@saga/shared/logging';

export interface WorkerOptions {
  pool: SagaPool;
  jobs: JobService;
  services: ServiceInstanceRepository;
  registry: JobHandlerRegistry;
  logger: SagaLogger;
  version: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseSeconds: number;
  serviceLeaseSeconds: number;
  heartbeatIntervalMs: number;
}

/**
 * The worker loop.
 *
 *   1. register/renew the service-instance heartbeat
 *   2. claim eligible jobs with FOR UPDATE SKIP LOCKED and a fresh claim token
 *   3. run the handler, renewing the lease for long work
 *   4. complete, retry or fail — always guarded by the claim token
 *   5. periodically recover jobs whose worker died
 */
export class Worker {
  private readonly instanceKey: string;
  /** `shrine.jobs.claimed_by` is a uuid, so the worker carries one alongside its human key. */
  private readonly workerId: string;
  private readonly abort = new AbortController();
  private running = false;
  private inFlight = 0;
  private loopPromise: Promise<void> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WorkerOptions) {
    this.workerId = newUuid();
    this.instanceKey = `${hostname()}:${process.pid}:${this.workerId.slice(0, 8)}`;
  }

  get id(): string {
    return this.instanceKey;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.heartbeat('running');
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat('running').catch((error: unknown) => {
        this.options.logger.error({ err: error }, 'worker heartbeat failed');
      });
    }, this.options.heartbeatIntervalMs);
    this.heartbeatTimer.unref();

    // Stale-claim recovery runs on its own cadence so a wedged handler cannot delay it.
    this.reaperTimer = setInterval(
      () => {
        this.options.jobs.recoverExpiredLeases().catch((error: unknown) => {
          this.options.logger.error({ err: error }, 'stale job recovery failed');
        });
      },
      Math.max(5_000, this.options.leaseSeconds * 500),
    );
    this.reaperTimer.unref();

    this.loopPromise = this.loop();
    this.options.logger.info(
      { instance_key: this.instanceKey, handlers: this.options.registry.types() },
      'Saga worker started',
    );
  }

  private async loop(): Promise<void> {
    const { jobs, registry, logger, concurrency, pollIntervalMs } = this.options;

    while (!this.abort.signal.aborted) {
      const capacity = concurrency - this.inFlight;
      if (capacity <= 0) {
        await sleep(25, this.abort.signal);
        continue;
      }

      let claimed: ClaimedJob[] = [];
      try {
        claimed = await jobs.claim({
          workerId: this.workerId,
          limit: capacity,
          jobTypes: registry.types(),
          leaseSeconds: this.options.leaseSeconds,
        });
      } catch (error) {
        // A transient database problem must not kill the loop; back off and try again.
        logger.error({ err: error }, 'job claim failed');
        await sleep(pollIntervalMs, this.abort.signal);
        continue;
      }

      if (claimed.length === 0) {
        await sleep(pollIntervalMs, this.abort.signal);
        continue;
      }

      for (const job of claimed) {
        this.inFlight += 1;
        void this.process(job).finally(() => {
          this.inFlight -= 1;
        });
      }
    }
  }

  private async process(job: ClaimedJob): Promise<void> {
    const { jobs, registry, logger } = this.options;
    const jobLogger = logger.child({
      job_id: job.id,
      job_type: job.jobType,
      project_id: job.projectId ?? undefined,
      correlation_id: job.correlationId ?? undefined,
      attempt: job.attempts,
    });

    const handler = registry.get(job.jobType);
    if (handler === undefined) {
      // An unknown type means this build does not implement it: retrying cannot help.
      await jobs.recordFailure(
        job,
        `No handler is registered for job type "${job.jobType}".`,
        'permanent',
      );
      jobLogger.error('no handler registered for job type');
      return;
    }

    const startedAt = Date.now();
    try {
      const result = await handler.handle({
        job,
        logger: jobLogger,
        signal: this.abort.signal,
        renewLease: () => jobs.renewLease(job, this.options.leaseSeconds),
      });
      await jobs.succeed(job, result);
      jobLogger.info({ latency_ms: Date.now() - startedAt }, 'job succeeded');
    } catch (error) {
      const kind = classifyFailure(error);
      const message = errorMessage(error);
      try {
        const outcome = await jobs.recordFailure(job, message, kind);
        jobLogger.warn(
          { latency_ms: Date.now() - startedAt, outcome, failure_kind: kind, reason: message },
          'job failed',
        );
      } catch (recordError) {
        // Losing the claim here is expected after a lease recovery; anything else is a bug.
        jobLogger.error({ err: recordError }, 'could not record job failure');
      }
    }
  }

  private async heartbeat(state: 'running' | 'draining' | 'stopped'): Promise<void> {
    await this.options.services.heartbeat(this.options.pool, {
      role: 'worker',
      instanceKey: this.instanceKey,
      version: this.options.version,
      hostname: hostname(),
      processId: process.pid,
      state,
      leaseSeconds: this.options.serviceLeaseSeconds,
      metadata: {
        worker_id: this.workerId,
        concurrency: this.options.concurrency,
        handlers: this.options.registry.types(),
        in_flight: this.inFlight,
      },
    });
  }

  /**
   * Stop claiming, let in-flight work finish within the timeout, and stop renewing leases so
   * anything still running is recovered by another worker rather than half-completed here.
   */
  async stop(timeoutMs = 15_000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.reaperTimer !== null) clearInterval(this.reaperTimer);

    try {
      await this.heartbeat('draining');
    } catch (error) {
      this.options.logger.warn({ err: error }, 'could not record draining state');
    }

    await this.loopPromise;

    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    if (this.inFlight > 0) {
      this.options.logger.warn(
        { in_flight: this.inFlight },
        'shutdown timeout reached with jobs still running; their leases will expire and be recovered',
      );
    }

    try {
      await this.options.services.markStopped(this.options.pool, 'worker', this.instanceKey);
    } catch (error) {
      this.options.logger.warn({ err: error }, 'could not mark worker instance stopped');
    }
  }
}

function classifyFailure(error: unknown): 'retryable' | 'permanent' {
  if (error instanceof JobHandlerError) return error.kind;
  if (isSagaError(error)) return error.retryable ? 'retryable' : 'permanent';
  // An unrecognised error is assumed transient; `max_attempts` bounds the damage.
  return 'retryable';
}
