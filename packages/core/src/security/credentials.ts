import { randomBytes } from 'node:crypto';
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
  // The display hint is derived from the *hash*, never from the secret itself. `token_prefix`
  // is returned by every token listing, so putting a literal slice of the secret there would
  // persist part of it in plaintext and re-display it forever — against spec 7.20 ("store only
  // secure hashes") and 17.2 ("displayed only once when created").
  const hash = sha256Hex(raw);
  return { raw, hash, prefix: `${TOKEN_PREFIX}_${slug}_${hash.slice(0, 6)}` };
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
  // Sampled from raw bytes with rejection, not by folding another alphabet's char codes into
  // this one: 256 is not a multiple of 31, and `charCode % 31` over base32 text made `a`, `b`,
  // `c`, `d` and `9` impossible while `w`-`3` came up twice as often as everything else.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let userCode = '';
  while (userCode.replace('-', '').length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte >= limit) continue;
      userCode += alphabet[byte % alphabet.length];
      if (userCode.length === 4) userCode += '-';
      if (userCode.replace('-', '').length === 8) break;
    }
  }
  return { deviceCode, deviceCodeHash: sha256Hex(deviceCode), userCode: userCode.toUpperCase() };
}

export function normalizeUserCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}
