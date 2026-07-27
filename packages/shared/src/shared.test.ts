import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from './backoff.js';
import { loadConfig } from './config.js';
import { SagaError, defaultStatusFor } from './errors.js';
import { buildPage, clampPageSize, decodeCursor, encodeCursor } from './pagination.js';
import { redactText, redactValue, sanitizeConnectionString } from './redaction.js';
import { addSeconds, fixedClock, isExpired, toIso } from './time.js';
import { estimateTokens, truncateToTokens } from './tokens.js';

describe('errors', () => {
  it('maps codes to their documented HTTP status', () => {
    expect(defaultStatusFor('QUEST_REVISION_CONFLICT')).toBe(409);
    expect(defaultStatusFor('RESOURCE_CLAIM_CONFLICT')).toBe(409);
    expect(defaultStatusFor('SCOPE_REQUIRED')).toBe(403);
    expect(defaultStatusFor('VALIDATION_FAILED')).toBe(422);
    expect(defaultStatusFor('COORDINATION_UNAVAILABLE')).toBe(503);
  });

  it('renders a stable envelope', () => {
    const error = new SagaError('QUEST_REVISION_CONFLICT', 'The Quest changed.', {
      details: { latest_revision: 7 },
    });
    expect(error.toEnvelope('req_abc')).toEqual({
      error: {
        code: 'QUEST_REVISION_CONFLICT',
        message: 'The Quest changed.',
        details: { latest_revision: 7 },
        request_id: 'req_abc',
      },
    });
  });

  it('treats 5xx as retryable and 4xx as not', () => {
    expect(new SagaError('SERVICE_UNAVAILABLE', 'x').retryable).toBe(true);
    expect(new SagaError('VALIDATION_FAILED', 'x').retryable).toBe(false);
  });
});

describe('backoff', () => {
  it('grows exponentially and is capped', () => {
    const opts = { baseMs: 1_000, factor: 2, maxMs: 10_000, jitter: 0 };
    expect(backoffDelayMs(1, 0, opts)).toBe(1_000);
    expect(backoffDelayMs(2, 0, opts)).toBe(2_000);
    expect(backoffDelayMs(3, 0, opts)).toBe(4_000);
    expect(backoffDelayMs(10, 0, opts)).toBe(10_000);
  });

  it('applies jitter deterministically for a given random value', () => {
    const opts = { baseMs: 1_000, factor: 2, maxMs: 10_000, jitter: 0.5 };
    expect(backoffDelayMs(1, 1, opts)).toBe(500);
    expect(backoffDelayMs(1, 0.5, opts)).toBe(750);
  });

  it('never returns a delay below zero or for attempt < 1', () => {
    expect(backoffDelayMs(0, 1, { baseMs: 100, jitter: 1 })).toBe(0);
    expect(backoffDelayMs(-5, 0, { baseMs: 100, jitter: 0 })).toBe(100);
  });
});

describe('token estimation', () => {
  it('is deterministic and monotonic', () => {
    expect(estimateTokens('')).toBe(0);
    const a = estimateTokens('hello world');
    expect(a).toBe(estimateTokens('hello world'));
    expect(estimateTokens('hello world and more')).toBeGreaterThan(a);
  });

  it('charges for newlines because structure costs tokens', () => {
    expect(estimateTokens('abcdefghij')).toBeLessThan(estimateTokens('abcde\nfghij'));
  });

  it('truncates on a paragraph boundary when possible', () => {
    const text = ['first paragraph here', 'second paragraph here', 'third'].join('\n\n');
    const budget = estimateTokens('first paragraph here') + 1;
    expect(truncateToTokens(text, budget)).toBe('first paragraph here');
  });

  it('returns the input untouched when it already fits', () => {
    expect(truncateToTokens('short', 1_000)).toBe('short');
  });

  it('returns an empty string for a non-positive budget', () => {
    expect(truncateToTokens('anything', 0)).toBe('');
  });
});

describe('redaction', () => {
  it('removes credentials from connection strings', () => {
    expect(redactText('postgres://saga:hunter2@db:5432/saga')).toBe(
      'postgres://saga:[redacted]@db:5432/saga',
    );
  });

  it('removes bearer tokens and saga agent tokens', () => {
    expect(redactText('Authorization: Bearer abcdef1234567890')).toContain('[redacted]');
    expect(redactText('saga_erp_abcdefghijklmnopqrstuvwxyz234567')).toBe('[redacted]');
  });

  it('removes PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIB\n-----END RSA PRIVATE KEY-----';
    expect(redactText(pem)).toBe('[redacted] (PEM private key)');
  });

  it('redacts sensitive object keys but keeps benign look-alikes', () => {
    const redacted = redactValue({
      password: 'hunter2',
      api_key: 'k',
      token_count: 42,
      session_id: 'sess-1',
      nested: { authorization: 'Bearer x' },
    }) as Record<string, unknown>;
    expect(redacted.password).toBe('[redacted]');
    expect(redacted.api_key).toBe('[redacted]');
    expect(redacted.token_count).toBe(42);
    expect(redacted.session_id).toBe('sess-1');
    expect((redacted.nested as Record<string, unknown>).authorization).toBe('[redacted]');
  });

  it('survives circular structures', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node.self = node;
    expect(redactValue(node)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('sanitizes connection strings for display', () => {
    expect(sanitizeConnectionString('postgres://saga:hunter2@db.internal:5432/saga_prod')).toBe(
      'postgres://saga@db.internal:5432/saga_prod',
    );
    expect(sanitizeConnectionString('not a url')).toBe('[redacted]');
  });
});

describe('time', () => {
  it('advances a fixed clock without touching the real one', () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');
    expect(toIso(clock.now())).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(5_000);
    expect(toIso(clock.now())).toBe('2026-01-01T00:00:05.000Z');
  });

  it('treats a null lease as expired', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(isExpired(null, now)).toBe(true);
    expect(isExpired(addSeconds(now, 10), now)).toBe(false);
    expect(isExpired(addSeconds(now, -1), now)).toBe(true);
    // A lease expiring exactly now is expired: leases are half-open intervals.
    expect(isExpired(now, now)).toBe(true);
  });
});

describe('pagination', () => {
  it('round-trips a cursor', () => {
    const payload = { k: '2026-01-01T00:00:00.000Z', id: 'abc-123' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it('rejects a malformed cursor', () => {
    expect(() => decodeCursor('!!!!')).toThrow(SagaError);
    expect(() => decodeCursor(encodeCursor({ k: 'x', id: 'y' }).slice(0, 3))).toThrow(SagaError);
  });

  it('clamps page size to the documented maximum', () => {
    expect(clampPageSize(undefined)).toBe(50);
    expect(clampPageSize(1_000)).toBe(200);
    expect(clampPageSize(0)).toBe(1);
  });

  it('detects more pages from the sentinel row', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = buildPage(rows, 2, (row) => ({ k: row.id, id: row.id }));
    expect(page.items).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).not.toBeNull();

    const last = buildPage(rows.slice(0, 2), 2, (row) => ({ k: row.id, id: row.id }));
    expect(last.has_more).toBe(false);
    expect(last.next_cursor).toBeNull();
  });
});

describe('config', () => {
  const baseEnv = {
    DATABASE_URL: 'postgres://saga:saga@localhost:5432/saga_dev',
    SAGA_SESSION_SECRET: 'a'.repeat(32),
  };

  it('applies documented defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config.api.port).toBe(4319);
    expect(config.party.mode).toBe('advisory');
    expect(config.embedding.dimensions).toBe(768);
    expect(config.context.coreTokens).toBe(3_500);
  });

  it('refuses the development auth bypass in production', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        SAGA_COOKIE_SECURE: 'true',
        SAGA_DEV_AUTH_BYPASS: 'true',
      }),
    ).toThrow(/SAGA_DEV_AUTH_BYPASS/);
  });

  it('requires secure cookies in production', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production' })).toThrow(/SAGA_COOKIE_SECURE/);
  });

  it('reports every missing required variable at once', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('parses a comma-separated CORS origin list', () => {
    const config = loadConfig({ ...baseEnv, SAGA_CORS_ORIGINS: 'https://a.test, https://b.test' });
    expect(config.api.corsOrigins).toEqual(['https://a.test', 'https://b.test']);
  });
});
