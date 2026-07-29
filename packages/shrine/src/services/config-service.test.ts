import { REDACTED } from '@saga/shared';
import { loadConfig } from '@saga/shared/config';
import { describe, expect, it } from 'vitest';
import { describeDatabase, sanitizeConfig } from './config-service.js';

/**
 * The credential-leak guard for Shrine's configuration view (spec 15.7, 19).
 *
 * `sanitizeConfig` is the only thing standing between an operator-visible screen and the
 * process environment, which holds the database password and the session secret.
 */

const SECRET = 'super-secret-session-value-32chars';
const PASSWORD = 'hunter2';
const DSN = `postgres://saga_user:${PASSWORD}@db.internal:5433/saga_prod?sslmode=require`;

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: DSN,
    SAGA_SESSION_SECRET: SECRET,
    NODE_ENV: 'test',
    ...overrides,
  });
}

describe('describeDatabase', () => {
  it('keeps the host and database name and drops the credentials', () => {
    expect(describeDatabase(DSN)).toEqual({ host: 'db.internal:5433', database: 'saga_prod' });
  });

  it('omits the port when the DSN does not name one', () => {
    expect(describeDatabase('postgres://user:pw@db.internal/saga')).toEqual({
      host: 'db.internal',
      database: 'saga',
    });
  });

  it('redacts both fields for a DSN it cannot parse', () => {
    // The fallback must not echo the input: a malformed DSN still contains the password.
    for (const malformed of ['', 'not a url', 'postgres://', '://x', 'host=db user=saga']) {
      const described = describeDatabase(malformed);
      expect([malformed, described.host]).toEqual([malformed, REDACTED]);
      expect(described.database).toBe(REDACTED);
    }
  });

  it('redacts the database name when the DSN carries no path', () => {
    expect(describeDatabase('postgres://user:pw@db.internal:5432')).toEqual({
      host: 'db.internal:5432',
      database: REDACTED,
    });
  });

  it('never returns the password for any DSN shape', () => {
    for (const dsn of [
      DSN,
      'postgres://user:pw@host/db',
      `postgresql://saga:${PASSWORD}@[::1]:5432/saga`,
      'not a url at all',
    ]) {
      expect(JSON.stringify(describeDatabase(dsn))).not.toContain(PASSWORD);
    }
  });
});

describe('sanitizeConfig', () => {
  const startedAt = new Date('2026-07-29T08:00:00.000Z');

  it('renders no credential from the loaded configuration', () => {
    const rendered = JSON.stringify(sanitizeConfig(config(), startedAt));
    expect(rendered).not.toContain(PASSWORD);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(DSN);
    expect(rendered).not.toContain('saga_user');
  });

  it('shows the operator the host and database it is actually connected to', () => {
    const view = sanitizeConfig(config(), startedAt);
    expect(view.database).toEqual({
      host: 'db.internal:5433',
      database: 'saga_prod',
      pool_max: 10,
    });
  });

  it('reports TLS from the public URL rather than assuming it', () => {
    expect(sanitizeConfig(config(), startedAt).tls_enabled).toBe(false);
    expect(
      sanitizeConfig(config({ SAGA_PUBLIC_URL: 'https://saga.example.internal' }), startedAt)
        .tls_enabled,
    ).toBe(true);
  });

  it('surfaces the development auth bypass, which an operator must be able to see', () => {
    expect(sanitizeConfig(config(), startedAt).dev_auth_bypass).toBe(false);
    expect(
      sanitizeConfig(config({ SAGA_DEV_AUTH_BYPASS: 'true' }), startedAt).dev_auth_bypass,
    ).toBe(true);
  });

  it('records the start time it was given, not the time it was called', () => {
    expect(sanitizeConfig(config(), startedAt).started_at).toBe('2026-07-29T08:00:00.000Z');
  });

  it('carries the operational numbers an operator needs to reason about the system', () => {
    const view = sanitizeConfig(config(), startedAt);
    expect(view.worker.concurrency).toBeGreaterThan(0);
    expect(view.retention.job_days).toBeGreaterThan(0);
    expect(view.context_budgets.core).toBeGreaterThan(0);
    expect(view.party_mode).toBeDefined();
  });

  it('still redacts the database when the DSN is malformed', () => {
    const view = sanitizeConfig(config({ DATABASE_URL: 'postgres-bad-dsn' }), startedAt);
    expect(view.database.host).toBe(REDACTED);
    expect(view.database.database).toBe(REDACTED);
  });
});
