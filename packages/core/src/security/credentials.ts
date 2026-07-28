import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { SagaError } from '@saga/shared';
import { randomBase32, safeEqual, sha256Hex } from '@saga/shared/ids';

/**
 * Argon2id parameters. OWASP's second-choice profile (19 MiB, t=2, p=1) — chosen because
 * Saga's reference deployment target is a small self-hosted machine where the 46 MiB profile
 * would make concurrent logins contend for memory. See ADR-0003.
 */
// `Algorithm` is an ambient const enum, which `verbatimModuleSyntax` cannot import as a value.
const ARGON2ID = 2 satisfies Algorithm;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new SagaError('VALIDATION_FAILED', 'A password must be at least 12 characters.');
  }
  if (password.length > 1_000) {
    throw new SagaError('VALIDATION_FAILED', 'A password may be at most 1000 characters.');
  }
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a server error that
    // would tell an attacker something about the account.
    return false;
  }
}

// --- opaque secrets --------------------------------------------------------

/** Web session ids are opaque random strings; only their hash reaches the database. */
export function generateSessionId(): string {
  return randomBase32(48);
}

export function generateCsrfToken(): string {
  return randomBase32(32);
}

export function hashSecret(value: string): string {
  return sha256Hex(value);
}

export function secretMatches(rawValue: string, storedHash: string): boolean {
  return safeEqual(sha256Hex(rawValue), storedHash);
}

// --- agent tokens ----------------------------------------------------------

const TOKEN_PREFIX = 'saga';

/**
 * `saga_<projectSlug>_<40 chars>`. The middle segment is a non-secret hint so an operator can
 * tell two tokens apart in a list; the entropy is entirely in the last segment.
 */
export function generateAgentToken(projectNameKey: string): {
  raw: string;
  hash: string;
  prefix: string;
} {
  const slug =
    projectNameKey
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 12)
      .padEnd(3, 'x') || 'prj';
  const secret = randomBase32(40);
  const raw = `${TOKEN_PREFIX}_${slug}_${secret}`;
  return { raw, hash: sha256Hex(raw), prefix: `${TOKEN_PREFIX}_${slug}_${secret.slice(0, 6)}` };
}

export function isAgentTokenShaped(value: string): boolean {
  return /^saga_[a-z0-9]{1,16}_[a-z2-7]{20,}$/.test(value);
}

/** Device codes: a long opaque secret plus a short human-typeable confirmation code. */
export function generateDeviceCode(): {
  deviceCode: string;
  deviceCodeHash: string;
  userCode: string;
} {
  const deviceCode = randomBase32(48);
  // Exclude look-alike characters so a user reading a code aloud cannot mistype it.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const raw = randomBase32(16);
  let userCode = '';
  for (let i = 0; i < 8; i += 1) {
    userCode += alphabet[raw.charCodeAt(i) % alphabet.length];
    if (i === 3) userCode += '-';
  }
  return { deviceCode, deviceCodeHash: sha256Hex(deviceCode), userCode: userCode.toUpperCase() };
}

export function normalizeUserCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}
