/**
 * Every timestamp Saga stores or emits is UTC. `Clock` exists so lease-expiry and
 * freshness arithmetic can be tested without sleeping.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at a fixed instant, advanceable by tests. */
export function fixedClock(start: Date | string): Clock & { advance(ms: number): void } {
  let current = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function toIsoRequired(value: Date | string): string {
  const iso = toIso(value);
  if (iso === null) throw new TypeError(`Invalid date: ${String(value)}`);
  return iso;
}

export function addSeconds(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * 1000);
}

export function addMinutes(from: Date, minutes: number): Date {
  return addSeconds(from, minutes * 60);
}

export function secondsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 1000;
}

export function isExpired(leaseExpiresAt: Date | string | null | undefined, now: Date): boolean {
  if (leaseExpiresAt === null || leaseExpiresAt === undefined) return true;
  const expiry = typeof leaseExpiresAt === 'string' ? new Date(leaseExpiresAt) : leaseExpiresAt;
  return expiry.getTime() <= now.getTime();
}

export function ageMs(since: Date | string, now: Date): number {
  const from = typeof since === 'string' ? new Date(since) : since;
  return now.getTime() - from.getTime();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
