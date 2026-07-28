export interface BackoffOptions {
  /** Delay before the first retry, in milliseconds. */
  baseMs?: number;
  /** Upper bound on any single delay, in milliseconds. */
  maxMs?: number;
  /** Multiplier applied per attempt. */
  factor?: number;
  /** Fraction of the computed delay that may be shaved off, in [0, 1]. */
  jitter?: number;
}

const DEFAULTS: Required<BackoffOptions> = {
  baseMs: 1_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.3,
};

/**
 * Exponential backoff with *decorrelated* jitter, expressed as a pure function of
 * `attempt` and a caller-supplied random value so it can be unit-tested exactly.
 *
 * `attempt` is 1-based: the delay before retry #1.
 */
export function backoffDelayMs(
  attempt: number,
  random: number,
  options: BackoffOptions = {},
): number {
  const { baseMs, maxMs, factor, jitter } = { ...DEFAULTS, ...options };
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = baseMs * factor ** (safeAttempt - 1);
  const capped = Math.min(raw, maxMs);
  const clampedRandom = Math.min(1, Math.max(0, random));
  const spread = capped * jitter * clampedRandom;
  return Math.round(capped - spread);
}

export function nextRetryAt(now: Date, attempt: number, options: BackoffOptions = {}): Date {
  return new Date(now.getTime() + backoffDelayMs(attempt, Math.random(), options));
}
