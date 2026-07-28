/**
 * Redaction used by the logger and by error serialisation. This is *not* the Lore secret
 * policy (that one rejects rather than hides — see `@saga/lore/secrets`); this one exists so
 * that an accidental credential never reaches a log sink.
 */

export const REDACTED = '[redacted]';

const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|apikey|authorization|auth|credential|private[_-]?key|session|cookie|salt|signature|dsn|connection[_-]?string)/i;

/** Keys that merely *look* sensitive but carry no secret material. */
const ALLOWED_KEYS = new Set([
  'token_count',
  'tokens',
  'token_budget',
  'session_id',
  'secret_detected',
  'auth_mode',
  'authenticated',
]);

const CREDENTIAL_URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s@]+):([^@\s]+)@/gi;
const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const SAGA_TOKEN_RE = /\bsaga_[a-z0-9]{2,16}_[a-z2-7]{20,}\b/gi;

/** Redact secret-shaped substrings from free text. */
export function redactText(input: string): string {
  return input
    .replace(PEM_RE, `${REDACTED} (PEM private key)`)
    .replace(
      CREDENTIAL_URL_RE,
      (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
    )
    .replace(BEARER_RE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(SAGA_TOKEN_RE, REDACTED);
}

export function isSensitiveKey(key: string): boolean {
  if (ALLOWED_KEYS.has(key)) return false;
  return SENSITIVE_KEY_RE.test(key);
}

/**
 * Deep-redact a value for logging. Objects are copied; the input is never mutated.
 * Cycles are replaced with `[circular]` rather than throwing.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
  }
  return out;
}

/** Hide the credential portion of a connection string while keeping it recognisable. */
export function sanitizeConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    const user = parsed.username;
    parsed.password = '';
    parsed.username = '';
    const auth = user.length > 0 ? `${user}@` : '';
    const database = parsed.pathname.replace(/^\//, '');
    return `${parsed.protocol}//${auth}${parsed.host}/${database}`;
  } catch {
    return REDACTED;
  }
}
