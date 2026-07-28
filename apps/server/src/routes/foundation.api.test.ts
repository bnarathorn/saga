import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiHarness, TEST_PASSWORD, type ApiHarness } from '../testing/api-harness.js';

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

describe('health endpoints', () => {
  it('answers /health/live without touching the database', async () => {
    const response = await harness.anonymous().get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('answers /health/ready with per-dependency detail', async () => {
    const response = await harness.anonymous().get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    const names = response.body.checks.map((check: { name: string }) => check.name).sort();
    expect(names).toEqual(['configuration', 'database', 'schema']);
  });

  it('puts a request id on every response', async () => {
    const response = await harness.anonymous().get('/health/live');
    expect(response.headers['x-request-id']).toMatch(/^req_/);
  });

  it('honours an inbound x-request-id so a trace survives the proxy hop', async () => {
    const response = await harness
      .anonymous()
      .get('/health/live', { 'x-request-id': 'trace-from-nginx' });
    expect(response.headers['x-request-id']).toBe('trace-from-nginx');
  });
});

describe('error envelope', () => {
  it('returns a stable envelope for an unknown route', async () => {
    const response = await harness.anonymous().get('/api/nope');
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(response.body.error.request_id).toMatch(/^req_/);
  });

  it('returns VALIDATION_FAILED with the offending field path', async () => {
    const admin = await harness.loginAs('admin');
    const response = await admin.post('/api/projects', { name: '' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body.error.details)).toContain('name');
  });
});

describe('authentication', () => {
  it('rejects anonymous access to project data', async () => {
    const response = await harness.anonymous().get('/api/projects');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects bad credentials with the same message as an unknown address', async () => {
    const client = harness.anonymous();
    await harness.loginAs('admin');
    const wrongPassword = await client.post('/api/auth/login', {
      email: 'admin@saga.test',
      password: 'not-the-password',
    });
    const unknownUser = await client.post('/api/auth/login', {
      email: 'nobody@saga.test',
      password: TEST_PASSWORD,
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('locks an account after repeated failures', async () => {
    await harness.loginAs('operator');
    const client = harness.anonymous();
    let last = await client.post('/api/auth/login', {
      email: 'operator@saga.test',
      password: 'wrong',
    });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await client.post('/api/auth/login', {
        email: 'operator@saga.test',
        password: 'wrong',
      });
    }
    expect(last.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('reports the signed-in user from /api/auth/me and clears it on logout', async () => {
    const admin = await harness.loginAs('admin');
    const before = await admin.get('/api/auth/me');
    expect(before.body).toMatchObject({ authenticated: true, actor_type: 'user' });
    expect(before.body.user.role).toBe('admin');

    await admin.post('/api/auth/logout');
    const after = await admin.get('/api/auth/me');
    expect(after.body.authenticated).toBe(false);
  });
});

describe('CSRF protection', () => {
  it('refuses a cookie-authenticated mutation without the CSRF header', async () => {
    const admin = await harness.loginAs('admin');
    const response = await admin.postWithoutCsrf('/api/projects', { name: 'Should Not Exist' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('refuses a CSRF header that does not match the cookie', async () => {
    const admin = await harness.loginAs('admin');
    const response = await admin.post(
      '/api/projects',
      { name: 'Nope' },
      { 'x-saga-csrf': 'forged-value' },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('does not require CSRF for a safe method', async () => {
    const admin = await harness.loginAs('admin');
    expect((await admin.get('/api/projects')).status).toBe(200);
  });
});

describe('authorization matrix', () => {
  it('lets an admin create projects but not a viewer', async () => {
    const admin = await harness.loginAs('admin');
    expect((await admin.post('/api/projects', { name: 'Admin Project' })).status).toBe(201);

    const viewer = await harness.loginAs('viewer');
    const denied = await viewer.post('/api/projects', { name: 'Viewer Project' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
  });

  it('lets a viewer read Shrine but never operate it', async () => {
    const admin = await harness.loginAs('admin');
    const probe = await admin.post('/api/shrine/jobs/probe', { echo: 'x' });
    expect(probe.status).toBe(201);

    const viewer = await harness.loginAs('viewer');
    expect((await viewer.get('/api/shrine/jobs')).status).toBe(200);
    const denied = await viewer.post(`/api/shrine/jobs/${probe.body.job.id}/cancel`, {
      reason: 'because',
    });
    expect(denied.status).toBe(403);
  });

  it('lets an operator retry jobs but not manage tokens', async () => {
    const admin = await harness.loginAs('admin');
    const project = await admin.post('/api/projects', { name: 'Operator Scope' });

    const operator = await harness.loginAs('operator');
    const tokenAttempt = await operator.post(`/api/projects/${project.body.project.id}/tokens`, {
      name: 'nope',
      scopes: ['project:read'],
    });
    expect(tokenAttempt.status).toBe(403);
  });

  it('requires a reason for disruptive administrative actions', async () => {
    const admin = await harness.loginAs('admin');
    const probe = await admin.post('/api/shrine/jobs/probe', { echo: 'x' });
    const noReason = await admin.post(`/api/shrine/jobs/${probe.body.job.id}/cancel`, {});
    expect(noReason.status).toBe(422);
    expect(JSON.stringify(noReason.body.error.details)).toContain('reason');
  });
});

describe('project API', () => {
  it('creates, renames and resolves by alias', async () => {
    const admin = await harness.loginAs('admin');
    const created = await admin.post('/api/projects', { name: 'ERP Backoffice' });
    expect(created.status).toBe(201);
    const id = created.body.project.id;

    const renamed = await admin.patch(`/api/projects/${encodeURIComponent('ERP Backoffice')}`, {
      name: 'ERP Back Office',
    });
    expect(renamed.body.project.id).toBe(id);
    expect(renamed.body.project.aliases).toEqual(['ERP Backoffice']);

    const viaAlias = await admin.get(`/api/projects/${encodeURIComponent('erp backoffice')}`);
    expect(viaAlias.body.project.id).toBe(id);
    expect(viaAlias.body.project.bootstrap_required).toBe(true);
  });

  it('accepts no version-control fields on create', async () => {
    const admin = await harness.loginAs('admin');
    const created = await admin.post('/api/projects', {
      name: 'No VCS Project',
      repository_url: 'https://example.test/repo.git',
      branch: 'main',
    });
    expect(created.status).toBe(201);
    // Unknown fields are ignored, never stored, and never echoed back.
    expect(Object.keys(created.body.project)).not.toContain('repository_url');
    expect(Object.keys(created.body.project)).not.toContain('branch');
  });

  it('archives and restores with an audit reason', async () => {
    const admin = await harness.loginAs('admin');
    await admin.post('/api/projects', { name: 'Retired' });
    expect(
      (await admin.post('/api/projects/Retired/archive', { reason: 'shut down' })).status,
    ).toBe(200);

    const blocked = await admin.patch('/api/projects/Retired', { description: 'x' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('PROJECT_ARCHIVED');

    expect((await admin.post('/api/projects/Retired/restore', { reason: 'back' })).status).toBe(
      200,
    );
    const audit = await admin.get('/api/shrine/audit?limit=50');
    const actions = audit.body.items.map((entry: { action: string }) => entry.action);
    expect(actions).toContain('project.archived');
    expect(actions).toContain('project.restored');
  });

  it('paginates with a stable cursor', async () => {
    const admin = await harness.loginAs('admin');
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      await admin.post('/api/projects', { name });
    }
    const first = await admin.get('/api/projects?limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.has_more).toBe(true);

    const second = await admin.get(
      `/api/projects?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    expect(second.body.items).toHaveLength(1);
    expect(second.body.has_more).toBe(false);
    expect(second.body.items[0].name).toBe('Charlie');
  });
});

describe('idempotency', () => {
  it('replays the stored response for the same key and body', async () => {
    const admin = await harness.loginAs('admin');
    const headers = { 'idempotency-key': 'create-project-abc123' };
    const first = await admin.post('/api/projects', { name: 'Idempotent' }, headers);
    const second = await admin.post('/api/projects', { name: 'Idempotent' }, headers);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.project.id).toBe(first.body.project.id);
    expect(second.headers['idempotency-replayed']).toBe('true');

    const list = await admin.get('/api/projects');
    expect(list.body.items).toHaveLength(1);
  });

  it('rejects the same key with a different body', async () => {
    const admin = await harness.loginAs('admin');
    const headers = { 'idempotency-key': 'create-project-abc123' };
    await admin.post('/api/projects', { name: 'First' }, headers);
    const mismatch = await admin.post('/api/projects', { name: 'Second' }, headers);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes idempotency keys per actor', async () => {
    const admin = await harness.loginAs('admin');
    const operator = await harness.loginAs('operator');
    const headers = { 'idempotency-key': 'shared-key-value' };

    const byAdmin = await admin.post('/api/projects', { name: 'Admin One' }, headers);
    const byOperator = await operator.post('/api/projects', { name: 'Operator One' }, headers);
    expect(byAdmin.status).toBe(201);
    expect(byOperator.status).toBe(201);
    expect(byOperator.body.project.id).not.toBe(byAdmin.body.project.id);
  });

  it('frees the key when the operation fails', async () => {
    const admin = await harness.loginAs('admin');
    const headers = { 'idempotency-key': 'retry-after-failure' };
    await admin.post('/api/projects', { name: 'Taken' });

    const conflict = await admin.post('/api/projects', { name: 'taken' }, headers);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('PROJECT_NAME_CONFLICT');

    // The same key must work once the caller fixes the request.
    const retry = await admin.post('/api/projects', { name: 'Not Taken' }, headers);
    expect(retry.status).toBe(201);
  });
});

describe('agent tokens', () => {
  it('is project-scoped and cannot reach another project', async () => {
    const admin = await harness.loginAs('admin');
    const mine = await admin.post('/api/projects', { name: 'Mine' });
    const theirs = await admin.post('/api/projects', { name: 'Theirs' });

    const issued = await admin.post(`/api/projects/${mine.body.project.id}/tokens`, {
      name: 'agent',
      scopes: ['project:read', 'lore:read'],
    });
    expect(issued.status).toBe(201);
    expect(issued.body.raw_token).toMatch(/^saga_[a-z0-9]+_[a-z2-7]+$/);

    const agent = harness.withAgentToken(issued.body.raw_token);
    expect((await agent.get(`/api/projects/${mine.body.project.id}`)).status).toBe(200);

    // 404 rather than 403: a token must not be able to confirm another project exists.
    const cross = await agent.get(`/api/projects/${theirs.body.project.id}`);
    expect(cross.status).toBe(404);

    const list = await agent.get('/api/projects');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(mine.body.project.id);
  });

  it('never returns the token hash and shows the raw value only once', async () => {
    const admin = await harness.loginAs('admin');
    const project = await admin.post('/api/projects', { name: 'Token Project' });
    const issued = await admin.post(`/api/projects/${project.body.project.id}/tokens`, {
      name: 'agent',
      scopes: ['project:read'],
    });

    const listed = await admin.get(`/api/projects/${project.body.project.id}/tokens`);
    const serialized = JSON.stringify(listed.body);
    expect(serialized).not.toContain(issued.body.raw_token);
    expect(serialized).not.toContain('token_hash');
    expect(listed.body.items[0].token_prefix).toMatch(/^saga_/);
  });

  it('rejects a revoked token', async () => {
    const admin = await harness.loginAs('admin');
    const project = await admin.post('/api/projects', { name: 'Revoke Project' });
    const issued = await admin.post(`/api/projects/${project.body.project.id}/tokens`, {
      name: 'agent',
      scopes: ['project:read'],
    });

    const agent = harness.withAgentToken(issued.body.raw_token);
    expect((await agent.get('/api/auth/me')).body.authenticated).toBe(true);

    await admin.post(`/api/tokens/${issued.body.token.id}/revoke`, { reason: 'rotating' });
    const after = await agent.get('/api/auth/me');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('TOKEN_REVOKED');
  });

  it('enforces scopes, not just authentication', async () => {
    const admin = await harness.loginAs('admin');
    const project = await admin.post('/api/projects', { name: 'Scope Project' });
    const issued = await admin.post(`/api/projects/${project.body.project.id}/tokens`, {
      name: 'read only',
      scopes: ['project:read'],
    });

    const agent = harness.withAgentToken(issued.body.raw_token);
    const denied = await agent.post('/api/shrine/jobs/probe', {});
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('SCOPE_REQUIRED');
  });
});

describe('shrine API', () => {
  it('reports health with per-check status', async () => {
    const admin = await harness.loginAs('admin');
    const response = await admin.get('/api/shrine/health');
    expect(response.status).toBe(200);
    expect(['healthy', 'degraded']).toContain(response.body.status);
    const names = response.body.checks.map((check: { name: string }) => check.name);
    expect(names).toContain('database');
    expect(names).toContain('job_queue');
  });

  it('never exposes credentials in the sanitized configuration', async () => {
    const admin = await harness.loginAs('admin');
    const response = await admin.get('/api/shrine/config');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(harness.config.security.sessionSecret);
    expect(serialized).not.toMatch(/postgres:\/\/[^"]*:[^"@]*@/);
    expect(response.body.config.database.database).toBeTruthy();
    expect(response.body.config.party_mode).toBeTruthy();
  });

  it('reports the schema version', async () => {
    const admin = await harness.loginAs('admin');
    const response = await admin.get('/api/shrine/schema');
    expect(response.body.schema.up_to_date).toBe(true);
    expect(response.body.schema.current_version).toBe(response.body.schema.expected_version);
  });

  it('summarises metrics for the dashboard', async () => {
    const admin = await harness.loginAs('admin');
    await admin.post('/api/projects', { name: 'Metrics Project' });
    const response = await admin.get('/api/shrine/metrics-summary');
    expect(response.body.metrics.projects.total).toBe(1);
    expect(response.body.metrics.jobs).toHaveProperty('queued');
    expect(response.body.metrics.services).toHaveProperty('worker_live');
  });

  it('summarises job payloads instead of echoing them', async () => {
    const admin = await harness.loginAs('admin');
    const probe = await admin.post('/api/shrine/jobs/probe', {
      echo: 'x'.repeat(400),
    });
    const job = await admin.get(`/api/shrine/jobs/${probe.body.job.id}`);
    expect(job.body.job.payload_summary.echo).toHaveLength(118);
    expect(job.body.job).not.toHaveProperty('payload');
  });
});

describe('rate limiting', () => {
  it('throttles the login endpoint independently of the rest of the API', async () => {
    const limited = await createApiHarness({
      config: { SAGA_LOGIN_RATE_LIMIT_PER_MINUTE: '3', SAGA_API_RATE_LIMIT_PER_MINUTE: '100000' },
    });
    try {
      await limited.reset();
      const client = limited.anonymous();
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await client.post('/api/auth/login', {
          email: 'nobody@saga.test',
          password: 'whatever',
        });
        statuses.push(response.status);
      }
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);

      // Reads are unaffected by the login throttle.
      expect((await client.get('/health/live')).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('development auth bypass', () => {
  it('treats every caller as an administrator and flags Shrine as degraded', async () => {
    const bypass = await createApiHarness({ config: { SAGA_DEV_AUTH_BYPASS: 'true' } });
    try {
      await bypass.reset();
      const anonymous = bypass.anonymous();
      const created = await anonymous.post('/api/projects', { name: 'Bypass Project' });
      expect(created.status).toBe(201);

      const health = await anonymous.get('/api/shrine/health');
      const authMode = health.body.checks.find(
        (check: { name: string }) => check.name === 'auth_mode',
      );
      expect(authMode.status).toBe('degraded');
      expect(health.body.status).toBe('degraded');
    } finally {
      await bypass.close();
    }
  });
});
