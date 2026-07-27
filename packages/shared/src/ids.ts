import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const BASE32URL = 'abcdefghijklmnopqrstuvwxyz234567';

export function newUuid(): string {
  return randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Crockford-ish lowercase base32 without padding. Used for tokens and human-visible codes. */
export function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BASE32URL[bytes[i]! % 32];
  }
  return out;
}

export function newRequestId(): string {
  return `req_${randomBase32(20)}`;
}

export function newCorrelationId(): string {
  return `cor_${randomBase32(20)}`;
}

/** A worker's per-attempt claim token. A stale worker holding an old token cannot finish a job. */
export function newClaimToken(): string {
  return `clm_${randomBase32(26)}`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function contentHash(value: string): string {
  return `sha256:${sha256Hex(value)}`;
}

/** Constant-time comparison for secrets. Returns false on any length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
