import { JobHandlerError, type JobHandler } from '@saga/shrine';
import { z } from 'zod';

const payloadSchema = z.object({
  /** Echoed back in the result. Used by the Phase 1 demo and by tests. */
  echo: z.string().max(500).optional(),
  /** Milliseconds to spend, so lease renewal can be exercised. */
  sleep_ms: z.number().int().min(0).max(60_000).optional(),
  /** Fail deterministically. `retryable` exercises backoff; `permanent` exercises give-up. */
  fail: z.enum(['retryable', 'permanent']).optional(),
});

/**
 * A deterministic no-op job. It exists so an operator can prove end to end — from Guild Hall
 * to the worker and back — that the queue is actually draining, without touching real data.
 */
export const noopHandler: JobHandler = {
  type: 'noop',
  describe: {
    input: '{ echo?: string, sleep_ms?: number, fail?: "retryable" | "permanent" }',
    idempotency: 'Pure: no side effects, so re-running is always safe.',
    retryPolicy: 'Standard exponential backoff with jitter, up to max_attempts.',
    sideEffects: 'None.',
    result: '{ echoed: string | null, slept_ms: number }',
    failureCodes: ['NOOP_REQUESTED_FAILURE'],
  },

  async handle({ job, signal, renewLease }) {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      throw JobHandlerError.permanent('The noop payload does not match its schema.', {
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    const payload = parsed.data;

    const sleepMs = payload.sleep_ms ?? 0;
    if (sleepMs > 0) {
      const step = 250;
      for (let elapsed = 0; elapsed < sleepMs && !signal.aborted; elapsed += step) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(step, sleepMs - elapsed)));
        // Long work must keep its lease alive or another worker will take the job over.
        if (elapsed > 0 && elapsed % 5_000 === 0) await renewLease();
      }
    }

    if (payload.fail !== undefined) {
      throw new JobHandlerError(
        payload.fail,
        `NOOP_REQUESTED_FAILURE: ${payload.fail} failure requested by payload.`,
      );
    }

    return { echoed: payload.echo ?? null, slept_ms: sleepMs };
  },
};
