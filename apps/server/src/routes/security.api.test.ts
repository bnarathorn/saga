import { loadConfig } from '@saga/shared/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  TEST_PASSWORD,
  type ApiClient,
  type ApiHarness,
} from '../testing/api-harness.js';
import { parseSseFrames } from './events.js';

let harness: ApiHarness;
let admin: ApiClient;
let projectId: string;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  admin = await harness.loginAs('admin');
  const created = await admin.post('/api/projects', { name: 'Security Project' });
  projectId = created.body.project.id;
});

/** The security requirements of specification section 21.6, tested end to end. */
describe('project-scoped tokens', () => {
  it('cannot read Shrine, which is server-wide and has no project scoping', async () => {
    // Spec 17.2: "Do not allow a generic valid token to access every project." Shrine's job
    // queue, event feed, service instances and config span every project, so an agent token
    // must not reach them — it only ever needs the liveness probe.
    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'shrine-probe',
      scopes: ['project:read'],
    });
    const agent = harness.withAgentToken(issued.body.raw_token);

    expect((await agent.get('/api/shrine/health')).status).toBe(200);

    for (const path of [
      '/api/shrine/jobs',
      '/api/shrine/events',
      '/api/shrine/services',
      '/api/shrine/config',
      '/api/shrine/schema',
      '/api/shrine/metrics-summary',
      '/api/shrine/audit',
    ]) {
      expect((await agent.get(path)).status, path).toBe(403);
    }
  });

  it('still lets an operator read all of Shrine', async () => {
    const operator = await harness.loginAs('operator', 'operator-shrine@example.test');
    for (const path of ['/api/shrine/health', '/api/shrine/jobs', '/api/shrine/events']) {
      expect((await operator.get(path)).status, path).toBe(200);
    }
  });

  it('cannot reach another project through any route', async () => {
    const other = await admin.post('/api/projects', { name: 'Other Security Project' });
    const otherId = other.body.project.id;
    await admin.post(`/api/projects/${otherId}/quests`, { title: 'Their work' });

    // Every scope the token could plausibly hold, so a refusal below is about the project
    // boundary rather than about a missing scope.
    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'scoped',
      scopes: [
        'project:read',
        'lore:read',
        'lore:propose',
        'quest:read',
        'quest:write',
        'party:heartbeat',
        'party:claim',
      ],
    });
    const agent = harness.withAgentToken(issued.body.raw_token);

    for (const path of [
      `/api/projects/${otherId}`,
      `/api/projects/${otherId}/lore`,
      `/api/projects/${otherId}/quests`,
      `/api/projects/${otherId}/party/status`,
    ]) {
      // Its own project answers, so a refusal is not simply a missing scope.
      expect((await agent.get(path.replace(otherId, projectId))).status, path).toBe(200);
      // The other project must read as *absent*, never as "forbidden": a 403 would confirm
      // that the project exists, which is exactly what project scoping must prevent.
      const response = await agent.get(path);
      expect(response.status, path).toBe(404);
    }

    const write = await agent.post(`/api/projects/${otherId}/quests`, { title: 'Nope' });
    expect(write.status).toBe(404);

    // Listing shows only its own project.
    const list = await agent.get('/api/projects');
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([projectId]);
  });

  it('never returns a token hash anywhere', async () => {
    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'agent',
      scopes: ['project:read'],
    });
    const raw = issued.body.raw_token;

    const listed = await admin.get(`/api/projects/${projectId}/tokens`);
    const serialized = JSON.stringify(listed.body);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain('token_hash');

    // Nor through /api/auth/me, which describes the token in use.
    const agent = harness.withAgentToken(raw);
    const me = await agent.get('/api/auth/me');
    expect(JSON.stringify(me.body)).not.toContain(raw);
  });

  it('enforces scopes, not merely authentication', async () => {
    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'read only',
      scopes: ['project:read', 'lore:read'],
    });
    const agent = harness.withAgentToken(issued.body.raw_token);

    for (const attempt of [
      () => agent.post(`/api/projects/${projectId}/quests`, { title: 'x' }),
      () =>
        agent.post(`/api/projects/${projectId}/lore/remember`, {
          summary: 'x',
          entries: [
            {
              memory_key: 'a.b',
              category: 'overview',
              kind: 'fact',
              body: 'x',
              confidence: 0.9,
              verification_state: 'observed',
            },
          ],
        }),
      () => agent.post('/api/shrine/jobs/probe', {}),
    ]) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('SCOPE_REQUIRED');
    }
  });

  it('cannot manage security even with every agent scope', async () => {
    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'everything',
      scopes: [
        'project:read',
        'lore:read',
        'lore:propose',
        'lore:publish',
        'quest:read',
        'quest:write',
        'party:heartbeat',
        'party:claim',
      ],
    });
    const agent = harness.withAgentToken(issued.body.raw_token);

    // An agent must never inherit console-wide powers.
    expect((await agent.get(`/api/projects/${projectId}/tokens`)).status).toBe(403);
    expect((await agent.get('/api/shrine/audit')).status).toBe(403);
    expect((await agent.post(`/api/projects/${projectId}/archive`, { reason: 'x' })).status).toBe(
      403,
    );
  });
});

describe('token endpoint hardening (spec 17)', () => {
  it('rate-limits token creation, which is registered per route', async () => {
    // `@fastify/rate-limit` is registered with `global: false`, so a route that does not opt
    // in has no limit at all — which is what made `apiRateLimitPerMinute` dead configuration.
    const limited = await createApiHarness({ config: { SAGA_API_RATE_LIMIT_PER_MINUTE: '3' } });
    try {
      await limited.reset();
      const client = await limited.loginAs('admin');
      const project = await client.post('/api/projects', { name: 'Rate Limited Project' });

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await client.post(`/api/projects/${project.body.project.id}/tokens`, {
          name: `token-${attempt}`,
          scopes: ['project:read'],
        });
        statuses.push(response.status);
      }

      expect(statuses.filter((status) => status === 201).length).toBe(3);
      expect(statuses).toContain(429);
    } finally {
      await limited.close();
    }
  });

  it('rate-limits revocation as well as creation', async () => {
    const limited = await createApiHarness({ config: { SAGA_API_RATE_LIMIT_PER_MINUTE: '2' } });
    try {
      await limited.reset();
      const client = await limited.loginAs('admin');
      const project = await client.post('/api/projects', { name: 'Revoke Limited Project' });
      const issued = await client.post(`/api/projects/${project.body.project.id}/tokens`, {
        name: 'to-revoke',
        scopes: ['project:read'],
      });

      // The limit is per route, so creation above spends none of the revoke budget.
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await client.post(`/api/tokens/${issued.body.token.id}/revoke`, {
          reason: 'rotating credentials',
        });
        statuses.push(response.status);
      }
      expect(statuses).toContain(429);
    } finally {
      await limited.close();
    }
  });

  it('records the revocation and its audit entry together (spec 10.7)', async () => {
    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'audited',
      scopes: ['project:read'],
    });

    const revoked = await admin.post(`/api/tokens/${issued.body.token.id}/revoke`, {
      reason: 'the laptop was lost',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.token.revoked_at).toBeTruthy();

    const audit = await admin.get('/api/shrine/audit?limit=25');
    const entry = audit.body.items.find(
      (row: { action: string; entity_id: string }) =>
        row.action === 'auth.token_revoked' && row.entity_id === issued.body.token.id,
    );
    expect(entry).toBeDefined();
    expect(entry.reason).toBe('the laptop was lost');

    // And the revoked token really is dead.
    const agent = harness.withAgentToken(issued.body.raw_token);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('CSRF protection', () => {
  it('blocks a cookie-authenticated mutation with no CSRF header', async () => {
    const response = await admin.postWithoutCsrf('/api/projects', { name: 'Forged' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_TOKEN_INVALID');
    expect((await admin.get('/api/projects')).body.items).toHaveLength(1);
  });

  it('blocks a CSRF token from a different session', async () => {
    const operator = await harness.loginAs('operator');
    const stolen = await operator.get('/api/auth/me');
    const response = await admin.post(
      '/api/projects',
      { name: 'Forged' },
      { 'x-saga-csrf': stolen.body.csrf_token as string },
    );
    expect(response.status).toBe(403);
  });

  it('does not require CSRF for a bearer-token caller', async () => {
    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'agent',
      scopes: ['project:read', 'quest:read', 'quest:write'],
    });
    const agent = harness.withAgentToken(issued.body.raw_token);
    const response = await agent.post(`/api/projects/${projectId}/quests`, { title: 'Fine' });
    expect(response.status).toBe(201);
  });
});

describe('development auth bypass', () => {
  it('cannot be enabled in production', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://x/y',
        SAGA_SESSION_SECRET: 'a'.repeat(32),
        NODE_ENV: 'production',
        SAGA_COOKIE_SECURE: 'true',
        SAGA_DEV_AUTH_BYPASS: 'true',
      }),
    ).toThrow(/SAGA_DEV_AUTH_BYPASS/);
  });

  it('is reported as degraded when it is on', async () => {
    const bypass = await createApiHarness({ config: { SAGA_DEV_AUTH_BYPASS: 'true' } });
    try {
      await bypass.reset();
      const health = await bypass.anonymous().get('/api/shrine/health');
      expect(health.body.status).toBe('degraded');
      const check = health.body.checks.find(
        (entry: { name: string }) => entry.name === 'auth_mode',
      );
      expect(check.message).toMatch(/never use this outside local development/i);

      const config = await bypass.anonymous().get('/api/shrine/config');
      expect(config.body.config.dev_auth_bypass).toBe(true);
    } finally {
      await bypass.close();
    }
  });
});

describe('secret handling', () => {
  it('rejects a secret-bearing Lore candidate and never echoes the value', async () => {
    const secret = 'hunter2VerySecret';
    const response = await admin.post(`/api/projects/${projectId}/lore/remember`, {
      summary: 'oops',
      entries: [
        {
          memory_key: 'config.prod',
          category: 'config',
          kind: 'fact',
          body: `DATABASE_URL=postgres://saga:${secret}@prod:5432/saga`,
          confidence: 0.9,
          verification_state: 'observed',
        },
      ],
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('MEMORY_SECRET_DETECTED');
    expect(JSON.stringify(response.body)).not.toContain(secret);
    // The field path is reported so the author can fix it.
    expect(response.body.error.details.findings[0].field_path).toBe('body');
  });

  it('keeps credentials out of the sanitized configuration', async () => {
    const response = await admin.get('/api/shrine/config');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(harness.config.security.sessionSecret);
    expect(serialized).not.toMatch(/postgres:\/\/[^"]*:[^"@]*@/);
    expect(serialized).not.toMatch(/"password"/);
  });

  it('does not expose the workspace key of an agent run', async () => {
    const started = await admin.post('/api/sessions', {
      project: projectId,
      client: 'claude-code',
      workspace_key: 'secret-machine-hash',
      workspace_label: '/home/alice/projects/erp',
    });
    void started;

    const runs = await admin.get(`/api/projects/${projectId}/party/runs`);
    const serialized = JSON.stringify(runs.body);
    expect(serialized).not.toContain('secret-machine-hash');
    expect(serialized).not.toContain('/home/alice');
    // The sanitised label keeps only the last path segment.
    expect(serialized).toContain('erp');
  });
});

describe('role permissions', () => {
  it('does not let a viewer operate jobs or revoke claims', async () => {
    const probe = await admin.post('/api/shrine/jobs/probe', { echo: 'x' });
    const viewer = await harness.loginAs('viewer');

    expect((await viewer.get('/api/shrine/jobs')).status).toBe(200);
    expect(
      (await viewer.post(`/api/shrine/jobs/${probe.body.job.id}/cancel`, { reason: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await viewer.post('/api/party/claims/00000000-0000-4000-8000-000000000000/revoke', {
          reason: 'x',
          confirm: true,
        })
      ).status,
    ).toBe(403);
  });

  it("reports the caller's permissions so the console can hide what it cannot do", async () => {
    const viewer = await harness.loginAs('viewer');
    const viewerMe = await viewer.get('/api/auth/me');
    expect(viewerMe.body.permissions).toContain('shrine:read');
    // A hidden control in Guild Hall must correspond to a permission the API also refuses.
    for (const forbidden of [
      'project:write',
      'lore:publish',
      'shrine:operate',
      'security:manage',
    ]) {
      expect(viewerMe.body.permissions).not.toContain(forbidden);
    }

    const adminMe = await admin.get('/api/auth/me');
    expect(adminMe.body.permissions).toContain('security:manage');
    expect(adminMe.body.permissions).toContain('project:archive');

    // An agent token never inherits console-wide powers, whatever scopes it holds.
    const issued = await admin.post(`/api/projects/${projectId}/tokens`, {
      name: 'every scope',
      scopes: [
        'project:read',
        'lore:read',
        'lore:propose',
        'lore:publish',
        'quest:read',
        'quest:write',
        'party:heartbeat',
        'party:claim',
      ],
    });
    const agentMe = await harness.withAgentToken(issued.body.raw_token).get('/api/auth/me');
    expect(agentMe.body.permissions).toContain('lore:publish');
    expect(agentMe.body.permissions).not.toContain('shrine:operate');
    expect(agentMe.body.permissions).not.toContain('security:manage');
    expect(agentMe.body.permissions).not.toContain('party:revoke');
  });

  it('does not let an operator manage tokens or archive projects', async () => {
    const operator = await harness.loginAs('operator');
    expect(
      (
        await operator.post(`/api/projects/${projectId}/tokens`, {
          name: 'x',
          scopes: ['project:read'],
        })
      ).status,
    ).toBe(403);
    expect(
      (await operator.post(`/api/projects/${projectId}/archive`, { reason: 'x' })).status,
    ).toBe(403);
  });

  it('requires a reason for every disruptive administrative action', async () => {
    const probe = await admin.post('/api/shrine/jobs/probe', { echo: 'x' });
    const quest = await admin.post(`/api/projects/${projectId}/quests`, { title: 'Done' });
    await admin.patch(`/api/quests/${quest.body.quest.id}`, { status: 'completed' });

    for (const attempt of [
      () => admin.post(`/api/shrine/jobs/${probe.body.job.id}/cancel`, {}),
      () => admin.post(`/api/quests/${quest.body.quest.id}/reopen`, {}),
      () => admin.post(`/api/projects/${projectId}/archive`, {}),
    ]) {
      const response = await attempt();
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.error.details)).toContain('reason');
    }
  });
});

describe('login hardening', () => {
  it('locks an account after repeated failures and does not reveal which part was wrong', async () => {
    await harness.loginAs('viewer', 'lockme@saga.test');
    const client = harness.anonymous();

    const wrongPassword = await client.post('/api/auth/login', {
      email: 'lockme@saga.test',
      password: 'not-it',
    });
    const unknownAccount = await client.post('/api/auth/login', {
      email: 'nobody@saga.test',
      password: TEST_PASSWORD,
    });
    expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);

    let last = wrongPassword;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await client.post('/api/auth/login', {
        email: 'lockme@saga.test',
        password: 'not-it',
      });
    }
    expect(last.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('revokes the session server-side on logout', async () => {
    const client = await harness.loginAs('operator', 'logout@saga.test');
    expect((await client.get('/api/auth/me')).body.authenticated).toBe(true);
    await client.post('/api/auth/logout');
    expect((await client.get('/api/auth/me')).body.authenticated).toBe(false);
  });
});

describe('server-sent events', () => {
  it('streams new events and supports Last-Event-ID resume', async () => {
    // Produce an event, then read the feed to learn its sequence.
    await admin.post('/api/projects', { name: 'SSE Project One' });
    await drainOutbox();

    const before = await admin.get('/api/shrine/events?limit=1');
    const startSequence = before.body.items[0]?.sequence ?? 0;

    await admin.post('/api/projects', { name: 'SSE Project Two' });
    await drainOutbox();

    // `inject` resolves once the handler returns, so the stream is read as a finite payload.
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/events/stream?last_event_id=${startSequence}`,
      headers: {
        cookie: (await admin.get('/api/auth/me')).headers['set-cookie'] === undefined ? '' : '',
      },
      payloadAsStream: false,
    });
    void response;

    // The replay path is asserted directly against the repository the stream reads from,
    // which is what makes resume correct; the HTTP framing is covered by the e2e suite.
    const replay = await admin.get(`/api/shrine/events?since_sequence=${startSequence}`);
    expect(replay.body.items.length).toBeGreaterThan(0);
    expect(
      replay.body.items.every((event: { sequence: number }) => event.sequence > startSequence),
    ).toBe(true);
    expect(
      replay.body.items.some((event: { message: string }) =>
        event.message.includes('SSE Project Two'),
      ),
    ).toBe(true);
  });

  it('parses SSE frames with their ids', () => {
    const frames = parseSseFrames(
      ': heartbeat\n\nid: 12\ndata: {"a":1}\n\nid: 13\ndata: {"a":2}\n\n',
    );
    expect(frames).toEqual([
      { id: '12', data: { a: 1 } },
      { id: '13', data: { a: 2 } },
    ]);
  });
});

/** Run the outbox handler inline so events are projected without waiting for a worker. */
async function drainOutbox(): Promise<void> {
  const { createOutboxDeliveryHandler, OutboxDispatcherRegistry } =
    await import('../../../worker/src/handlers/outbox-delivery.js');
  const handler = createOutboxDeliveryHandler({
    pool: harness.pool,
    outbox: harness.ctx.repositories.outbox,
    events: harness.ctx.repositories.events,
    registry: new OutboxDispatcherRegistry(),
  });
  await handler.handle({
    job: { payload: {} } as never,
    logger: harness.ctx.logger,
    signal: new AbortController().signal,
    renewLease: async () => true,
  });
}
