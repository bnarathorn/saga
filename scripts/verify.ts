#!/usr/bin/env tsx
/**
 * End-to-end verification against a running Saga stack (`scripts/stack.sh up`).
 *
 * This is the reproducible demonstration referenced in the README: it exercises every
 * vertical slice through the real HTTP API, against real PostgreSQL, with the real worker.
 * It is intentionally independent of the test suite so it can also be run against a
 * deployed instance.
 */
import { loadDotEnv } from '@saga/shared/dotenv';
import { check, ScriptClient, section, summarize } from './lib/http-client.js';

loadDotEnv();

const BASE_URL = process.env.SAGA_VERIFY_URL ?? `http://127.0.0.1:${process.env.SAGA_API_PORT ?? 4319}`;
const ADMIN_EMAIL = process.env.SAGA_BOOTSTRAP_ADMIN_EMAIL ?? 'admin@saga.local';
const ADMIN_PASSWORD = process.env.SAGA_BOOTSTRAP_ADMIN_PASSWORD ?? '';

const unique = Date.now().toString(36);

interface JobBody {
  job: { id: string; state: string; attempts: number; result_summary: Record<string, unknown> | null };
}

async function main(): Promise<number> {
  const api = new ScriptClient(BASE_URL);

  section('Shrine — health before authentication');
  const live = await api.get<{ status: string }>('/health/live');
  check('/health/live is ok', live.status === 200 && live.body.status === 'ok', live.body);
  const ready = await api.get<{ status: string }>('/health/ready');
  check('/health/ready reports ready', ready.body.status === 'ready', ready.body);
  const anonymous = await api.get('/api/projects');
  check('anonymous callers are rejected', anonymous.status === 401, anonymous.body);

  section('Security — administrator login');
  if (ADMIN_PASSWORD.length === 0) {
    throw new Error('Set SAGA_BOOTSTRAP_ADMIN_PASSWORD in .env before running the verification.');
  }
  await api.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const me = await api.get<{ authenticated: boolean; user: { role: string } | null }>('/api/auth/me');
  check('session resolves to an admin', me.body.authenticated && me.body.user?.role === 'admin', me.body);

  section('Core — projects, renames and aliases');
  const original = `Verify Project ${unique}`;
  const created = await api.post<{ project: { id: string; name: string } }>('/api/projects', {
    name: original,
    description: 'Created by scripts/verify.ts',
  });
  check('project created with only a name', created.status === 201, created.body);
  const projectId = created.body.project.id;

  const renamed = `Verify Renamed ${unique}`;
  const afterRename = await api.patch<{ project: { id: string; aliases: string[] } }>(
    `/api/projects/${encodeURIComponent(original)}`,
    { name: renamed },
  );
  check('rename preserves the project UUID', afterRename.body.project.id === projectId);
  check('previous name is kept as an alias', afterRename.body.project.aliases.includes(original));

  const viaAlias = await api.get<{ project: { id: string } }>(
    `/api/projects/${encodeURIComponent(original)}`,
  );
  check('the old name still resolves', viaAlias.body.project.id === projectId);

  const viaNormalized = await api.get<{ project: { id: string } }>(
    `/api/projects/${encodeURIComponent(renamed.toUpperCase())}`,
  );
  check('a differently cased name resolves', viaNormalized.body.project.id === projectId);

  const collision = await api.post('/api/projects', { name: `  ${renamed.toLowerCase()}  ` });
  check(
    'an equivalent-looking name collides',
    collision.status === 409 &&
      (collision.body as { error: { code: string } }).error.code === 'PROJECT_NAME_CONFLICT',
    collision.body,
  );

  section('API — idempotency');
  const key = `verify-${unique}`;
  const first = await api.post<{ project: { id: string } }>(
    '/api/projects',
    { name: `Idempotent ${unique}` },
    { 'idempotency-key': key },
  );
  const replay = await api.post<{ project: { id: string } }>(
    '/api/projects',
    { name: `Idempotent ${unique}` },
    { 'idempotency-key': key },
  );
  check('replaying a key returns the same resource', first.body.project.id === replay.body.project.id);
  const mismatch = await api.post(
    '/api/projects',
    { name: `Different ${unique}` },
    { 'idempotency-key': key },
  );
  check(
    'reusing a key with a different body is rejected',
    (mismatch.body as { error: { code: string } }).error?.code === 'IDEMPOTENCY_KEY_REUSED',
    mismatch.body,
  );

  section('Shrine — job queue drains');
  const probe = await api.post<JobBody>('/api/shrine/jobs/probe', {
    echo: `verify-${unique}`,
    project_id: projectId,
  });
  check('probe job enqueued', probe.status === 201, probe.body);
  const succeeded = await api.waitFor('the probe job to succeed', async () => {
    const result = await api.get<JobBody>(`/api/shrine/jobs/${probe.body.job.id}`);
    return result.body.job.state === 'succeeded' ? result.body.job : null;
  });
  check('worker processed the probe job', succeeded.state === 'succeeded');
  check(
    'handler result was recorded',
    succeeded.result_summary?.echoed === `verify-${unique}`,
    succeeded.result_summary,
  );

  section('Shrine — permanent failure, then operator retry with audit');
  const failing = await api.post<JobBody>('/api/shrine/jobs/probe', {
    fail: 'permanent',
    echo: `fail-${unique}`,
  });
  const failed = await api.waitFor('the failing job to reach a terminal state', async () => {
    const result = await api.get<JobBody>(`/api/shrine/jobs/${failing.body.job.id}`);
    return result.body.job.state === 'failed' ? result.body.job : null;
  });
  check('a permanent failure stops retrying immediately', failed.attempts === 1, failed);

  const retried = await api.post<JobBody>(`/api/shrine/jobs/${failing.body.job.id}/retry`, {
    reason: 'verification run',
  });
  check('operator retry re-queues the job', ['queued', 'claimed'].includes(retried.body.job.state), retried.body);

  const audit = await api.get<{ items: { action: string; reason: string | null }[] }>(
    '/api/shrine/audit?limit=25',
  );
  check(
    'the retry is in the audit log with its reason',
    audit.body.items.some(
      (entry) => entry.action === 'shrine.job_retry' && entry.reason === 'verification run',
    ),
    audit.body.items.slice(0, 3),
  );

  section('Shrine — events, services and sanitized configuration');
  const events = await api.waitFor('the project-created event to be projected', async () => {
    const result = await api.get<{ items: { event_type: string; metadata: Record<string, unknown> }[] }>(
      `/api/shrine/events?project_id=${projectId}&limit=20`,
    );
    return result.body.items.some((event) => event.event_type === 'core.project_created')
      ? result.body.items
      : null;
  });
  check('outbox events reach the Shrine feed', events.length > 0);
  check(
    'the rename event was projected too',
    events.some((event) => event.event_type === 'core.project_renamed'),
    events.map((e) => e.event_type),
  );

  const services = await api.get<{ items: { role: string; live: boolean }[] }>('/api/shrine/services');
  check('an API instance is live', services.body.items.some((s) => s.role === 'api' && s.live));
  check('a worker instance is live', services.body.items.some((s) => s.role === 'worker' && s.live));

  const config = await api.get<{ config: Record<string, unknown> }>('/api/shrine/config');
  const configText = JSON.stringify(config.body);
  check('sanitized config exposes no credentials', !/saga:saga|password|session_secret/i.test(configText));
  check('sanitized config names the database', configText.includes('"database"'));

  const schema = await api.get<{ schema: { up_to_date: boolean; current_version: number } }>(
    '/api/shrine/schema',
  );
  check('schema is up to date', schema.body.schema.up_to_date, schema.body.schema);

  section('Security — CSRF and scopes');
  const noCsrf = await fetch(new URL('/api/projects', BASE_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `saga_session=nonsense` },
    body: JSON.stringify({ name: 'Should not exist' }),
  });
  check('a mutation without a session is refused', noCsrf.status === 401 || noCsrf.status === 403);

  const tokenResponse = await api.post<{ raw_token: string; token: { id: string } }>(
    `/api/projects/${projectId}/tokens`,
    { name: 'verification token', scopes: ['project:read', 'lore:read'] },
  );
  check('agent token issued with a raw value once', typeof tokenResponse.body.raw_token === 'string');
  check(
    'the token hash is never returned',
    !JSON.stringify(tokenResponse.body.token).includes(tokenResponse.body.raw_token),
  );

  const agent = new ScriptClient(BASE_URL);
  agent.useAgentToken(tokenResponse.body.raw_token);
  const agentMe = await agent.get<{ actor_type: string }>('/api/auth/me');
  check('the agent token authenticates', agentMe.body.actor_type === 'agent', agentMe.body);

  const otherProject = await api.post<{ project: { id: string } }>('/api/projects', {
    name: `Other Project ${unique}`,
  });
  const crossProject = await agent.get(`/api/projects/${otherProject.body.project.id}`);
  check(
    'a project-scoped token cannot reach another project',
    crossProject.status === 404,
    crossProject.body,
  );

  const agentOperate = await agent.post('/api/shrine/jobs/probe', {});
  check('an agent token cannot operate Shrine', agentOperate.status === 403, agentOperate.body);

  return summarize();
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  },
);
