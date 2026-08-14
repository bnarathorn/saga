#!/usr/bin/env tsx
/**
 * End-to-end verification against a running Saga stack (`scripts/stack.sh up`).
 *
 * This is the reproducible demonstration referenced in the README: it exercises every
 * vertical slice through the real HTTP API, against real PostgreSQL, with the real worker.
 * It is intentionally independent of the test suite so it can also be run against a
 * deployed instance.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { loadDotEnv } from '@saga/shared/dotenv';
import { check, ScriptClient, section, summarize } from './lib/http-client.js';

loadDotEnv();

const BASE_URL =
  process.env.SAGA_VERIFY_URL ?? `http://127.0.0.1:${process.env.SAGA_API_PORT ?? 4319}`;
const ADMIN_EMAIL =
  process.env.SAGA_VERIFY_ADMIN_EMAIL ??
  process.env.SAGA_BOOTSTRAP_ADMIN_EMAIL ??
  'admin@saga.local';

const ALLOW_PRODUCTION = process.env.SAGA_VERIFY_ALLOW_PRODUCTION === '1';

const unique = Date.now().toString(36);

/**
 * Projects this run created, so it can archive them on the way out. There is no delete
 * endpoint by design — archiving is what keeps them out of Guild Hall's project list.
 */
const createdProjects: string[] = [];

/**
 * Reads a secret without echoing it. `terminal: true` makes readline echo each keystroke to
 * its output, so the output here is a sink that forwards the prompt and then drops everything
 * — which is the echo.
 */
async function readSecret(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      if (!muted) process.stdout.write(chunk, typeof chunk === 'string' ? encoding : undefined);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = rl.question(prompt);
    muted = true;
    return await answer;
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

/**
 * The administrator password is a credential, so this script does not require it to sit in
 * `.env`. A password on disk beside `SAGA_API_PORT` is what let an accidental run authenticate
 * against production on 2026-08-13; the guard below stops that run reaching production at all,
 * and this stops the credential being lying around for the next one.
 *
 * Order: `SAGA_VERIFY_ADMIN_PASSWORD` for a deliberate inline or CI run, then
 * `SAGA_BOOTSTRAP_ADMIN_PASSWORD` for anyone who does keep it in `.env`, then an interactive
 * prompt. Without a TTY there is nothing to prompt, so say what to set instead.
 */
async function resolveAdminPassword(): Promise<string> {
  const fromEnv =
    process.env.SAGA_VERIFY_ADMIN_PASSWORD ?? process.env.SAGA_BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (fromEnv.length > 0) return fromEnv;

  if (!process.stdin.isTTY) {
    throw new Error(
      `No administrator password and no terminal to ask for one. Set ` +
        `SAGA_VERIFY_ADMIN_PASSWORD for ${ADMIN_EMAIL} on ${BASE_URL}, or run this from a terminal.`,
    );
  }

  const entered = await readSecret(`Password for ${ADMIN_EMAIL} on ${BASE_URL}: `);
  if (entered.length === 0) throw new Error('No password entered.');
  return entered;
}

/**
 * This script writes to whatever it is pointed at, and its default target is a port, not a
 * deployment: `SAGA_API_PORT` is 4319 in a developer's `.env` and 4319 in the systemd
 * reference deployment too. On a host running both, a verification with no stack up reaches
 * production, signs in with the bootstrap administrator and leaves its fixtures behind —
 * which is exactly what happened on 2026-08-13. The readiness probe names the deployment, so
 * refuse before the first write rather than after.
 */
function assertDisposableTarget(readiness: { environment?: string }): void {
  if (readiness.environment === undefined) {
    throw new Error(
      `${BASE_URL} does not report an environment on /health/ready, so this script cannot tell ` +
        'a scratch stack from production. Update the server, or set ' +
        'SAGA_VERIFY_ALLOW_PRODUCTION=1 if you accept that it will leave fixtures behind.',
    );
  }
  if (readiness.environment === 'production' && !ALLOW_PRODUCTION) {
    throw new Error(
      `${BASE_URL} is a production deployment. This script creates projects, agent tokens and ` +
        'jobs that it can only archive, never remove. Point SAGA_VERIFY_URL at a scratch stack, ' +
        'or set SAGA_VERIFY_ALLOW_PRODUCTION=1 to override deliberately.',
    );
  }
}

/**
 * Best-effort teardown. Runs even when a check threw, because a half-finished run leaks just
 * as much as a finished one. Failures here are reported, not thrown: they must never mask the
 * verification result.
 */
async function archiveCreatedProjects(api: ScriptClient): Promise<void> {
  if (createdProjects.length === 0) return;
  section('Cleanup — archiving the projects this run created');
  for (const ref of createdProjects) {
    const archived = await api.post(`/api/projects/${encodeURIComponent(ref)}/archive`, {
      reason: 'Fixture created by scripts/verify.ts',
    });
    check(`archived ${ref}`, archived.status === 200, archived.body);
  }
}

interface JobBody {
  job: {
    id: string;
    state: string;
    attempts: number;
    result_summary: Record<string, unknown> | null;
  };
}

async function verify(api: ScriptClient): Promise<void> {
  section('Shrine — health before authentication');
  const live = await api.get<{ status: string }>('/health/live');
  check('/health/live is ok', live.status === 200 && live.body.status === 'ok', live.body);
  const ready = await api.get<{ status: string; environment?: string }>('/health/ready');
  check('/health/ready reports ready', ready.body.status === 'ready', ready.body);
  assertDisposableTarget(ready.body);
  const anonymous = await api.get('/api/projects');
  check('anonymous callers are rejected', anonymous.status === 401, anonymous.body);

  section('Security — administrator login');
  await api.login(ADMIN_EMAIL, await resolveAdminPassword());
  const me = await api.get<{ authenticated: boolean; user: { role: string } | null }>(
    '/api/auth/me',
  );
  check(
    'session resolves to an admin',
    me.body.authenticated && me.body.user?.role === 'admin',
    me.body,
  );

  section('Core — projects, renames and aliases');
  const original = `Verify Project ${unique}`;
  const created = await api.post<{ project: { id: string; name: string } }>('/api/projects', {
    name: original,
    description: 'Created by scripts/verify.ts',
  });
  check('project created with only a name', created.status === 201, created.body);
  const projectId = created.body.project.id;
  createdProjects.push(projectId);

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
  createdProjects.push(first.body.project.id);
  check(
    'replaying a key returns the same resource',
    first.body.project.id === replay.body.project.id,
  );
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
  check(
    'operator retry re-queues the job',
    ['queued', 'claimed'].includes(retried.body.job.state),
    retried.body,
  );

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
    const result = await api.get<{
      items: { event_type: string; metadata: Record<string, unknown> }[];
    }>(`/api/shrine/events?project_id=${projectId}&limit=20`);
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

  const services = await api.get<{ items: { role: string; live: boolean }[] }>(
    '/api/shrine/services',
  );
  check(
    'an API instance is live',
    services.body.items.some((s) => s.role === 'api' && s.live),
  );
  check(
    'a worker instance is live',
    services.body.items.some((s) => s.role === 'worker' && s.live),
  );

  const config = await api.get<{ config: Record<string, unknown> }>('/api/shrine/config');
  const configText = JSON.stringify(config.body);
  check(
    'sanitized config exposes no credentials',
    !/saga:saga|password|session_secret/i.test(configText),
  );
  check('sanitized config names the database', configText.includes('"database"'));

  const schema = await api.get<{ schema: { up_to_date: boolean; current_version: number } }>(
    '/api/shrine/schema',
  );
  check('schema is up to date', schema.body.schema.up_to_date, schema.body.schema);

  section('Lore — propose, publish, search, context');
  const loreEntries = [
    {
      memory_key: 'project.overview',
      category: 'overview',
      kind: 'fact',
      body: 'An ERP back office for order and invoice management.',
      confidence: 0.95,
      verification_state: 'observed',
      importance: 95,
    },
    {
      memory_key: 'run.api.local',
      category: 'running',
      kind: 'procedure',
      body: 'Start PostgreSQL and Redis before starting the API.',
      data: { commands: ['docker compose up -d postgres redis', 'pnpm --filter api dev'] },
      evidence: [{ path: 'package.json', content_hash: `sha256:${'a'.repeat(64)}` }],
      confidence: 0.9,
      verification_state: 'observed',
    },
    {
      memory_key: 'warning.migrations',
      category: 'warning',
      kind: 'warning',
      body: 'Never run the destructive reset migration against a production database.',
      confidence: 1,
      verification_state: 'verified',
      importance: 100,
    },
  ];

  const beforeLore = await api.post(`/api/projects/${projectId}/context`, {});
  check(
    'a project with no Lore reports bootstrap_required with a plan',
    (beforeLore.body as { bootstrap_required: boolean }).bootstrap_required === true &&
      (beforeLore.body as { bootstrap_plan: { rules: string[] } }).bootstrap_plan.rules.length > 0,
    beforeLore.body,
  );

  const remembered = await api.post<{ update: { id: string; state: string } }>(
    `/api/projects/${projectId}/lore/remember`,
    { entries: loreEntries, summary: 'Record initial project knowledge' },
  );
  check(
    'agent-style remember creates a candidate update',
    remembered.status === 202,
    remembered.body,
  );

  const publishedUpdate = await api.waitFor(
    'the worker to validate, embed and publish the Lore update',
    async () => {
      const result = await api.get<{ update: { state: string } }>(
        `/api/lore/updates/${remembered.body.update.id}`,
      );
      return result.body.update.state === 'published' ? result.body.update : null;
    },
    60_000,
  );
  check('the worker published the update automatically', publishedUpdate.state === 'published');

  const entries = await api.get<{
    items: { memory_key: string; current_version: { embedding_state: string } }[];
    memory_revision: number;
  }>(`/api/projects/${projectId}/lore`);
  check(
    'the project Lore revision advanced to 1',
    entries.body.memory_revision === 1,
    entries.body.memory_revision,
  );
  check(
    'all three entries are published',
    entries.body.items.length === 3,
    entries.body.items.length,
  );

  const embedded = await api.waitFor(
    'embeddings to become ready',
    async () => {
      const result = await api.get<{ items: { current_version: { embedding_state: string } }[] }>(
        `/api/projects/${projectId}/lore`,
      );
      return result.body.items.every((item) => item.current_version.embedding_state === 'ready')
        ? result.body.items
        : null;
    },
    60_000,
  );
  check('every published version was embedded by the worker', embedded.length === 3);

  const searched = await api.post<{ hits: { memory_key: string }[]; mode: string }>(
    `/api/projects/${projectId}/lore/search`,
    { query: 'how do I start the API locally', limit: 5 },
  );
  check(
    'hybrid search finds the right entry first',
    searched.body.hits[0]?.memory_key === 'run.api.local',
    searched.body.hits,
  );
  check('search reports full (not degraded) mode', searched.body.mode === 'full');

  const context = await api.post<{
    core_context: string;
    task_context: string | null;
    bootstrap_required: boolean;
    token_counts: { core: number };
  }>(`/api/projects/${projectId}/context`, { task: 'Fix the local API startup', mode: 'new_work' });
  check('core context is compiled and non-empty', context.body.core_context.length > 0);
  check(
    'warnings are present in core context',
    context.body.core_context.includes('warning.migrations'),
  );
  check(
    'task context selects the relevant entry',
    context.body.task_context?.includes('run.api.local') === true,
  );
  check('bootstrap is no longer required', context.body.bootstrap_required === false);

  const secretAttempt = await api.post(`/api/projects/${projectId}/lore/remember`, {
    summary: 'accidental secret',
    entries: [
      {
        memory_key: 'config.production',
        category: 'config',
        kind: 'fact',
        body: 'DATABASE_URL=postgres://saga:hunter2xyz@prod.internal:5432/saga',
        confidence: 0.9,
        verification_state: 'observed',
      },
    ],
  });
  check(
    'a candidate containing a credential is rejected',
    (secretAttempt.body as { error: { code: string } }).error?.code === 'MEMORY_SECRET_DETECTED',
    secretAttempt.body,
  );
  check(
    'the rejection never echoes the secret',
    !JSON.stringify(secretAttempt.body).includes('hunter2xyz'),
  );

  const evidence = await api.post<{ drifted: unknown[]; marked_stale: string[] }>(
    `/api/projects/${projectId}/lore/evidence/check`,
    { observations: [{ path: 'package.json', content_hash: `sha256:${'b'.repeat(64)}` }] },
  );
  check(
    'drifted evidence marks the entry stale',
    evidence.body.marked_stale.includes('run.api.local'),
    evidence.body,
  );

  const afterStale = await api.post<{ warnings: string[] }>(
    `/api/projects/${projectId}/context`,
    {},
  );
  check(
    'context warns about stale knowledge',
    afterStale.body.warnings.some((warning) => warning.includes('stale')),
    afterStale.body.warnings,
  );

  section('Quest — two-phase startup, checkpoints and resume');
  const firstSession = await api.post<{
    session_id: string;
    state: string;
    open_quests: unknown[];
    bootstrap_required: boolean;
  }>('/api/sessions', { project: projectId, client: 'claude-code', agent: 'claude' });
  check(
    'a new session opens in awaiting_task',
    firstSession.body.state === 'awaiting_task',
    firstSession.body,
  );
  check(
    'phase one carries no continuation at all',
    !Object.prototype.hasOwnProperty.call(firstSession.body, 'continuation'),
  );

  const activated = await api.post<{
    activation_mode: string;
    quest: { id: string; title: string; revision: number; status: string };
    context: { continuation: unknown; task: string | null };
  }>(`/api/sessions/${firstSession.body.session_id}/activate`, {
    task: 'Add CSV report export',
    scope: { modules: ['services/api/src/reports'] },
  });
  check(
    'the first task creates new work',
    activated.body.activation_mode === 'new_work',
    activated.body,
  );
  check('a Quest was created and started', activated.body.quest.status === 'in_progress');
  check('no continuation is loaded for new work', activated.body.context.continuation === null);

  const questId = activated.body.quest.id;

  const checkpoint = await api.post<{ quest_revision: number; checkpoint: { sequence: number } }>(
    `/api/sessions/${firstSession.body.session_id}/checkpoints`,
    {
      expected_quest_revision: 0,
      kind: 'milestone',
      summary: 'Implemented the CSV generator and unit tests',
      work_state: {
        goal: 'Add CSV report export',
        completed: ['Implemented CSV serialization'],
        in_progress: ['Add API endpoint'],
        next_steps: ['Wire the endpoint to the report service'],
        blockers: [],
        decisions: [],
        changed_files: [],
        commands: [],
        tests: [],
      },
    },
  );
  check(
    'a checkpoint advances the Quest revision',
    checkpoint.body.quest_revision === 1,
    checkpoint.body,
  );

  const staleCheckpoint = await api.post(
    `/api/sessions/${firstSession.body.session_id}/checkpoints`,
    {
      expected_quest_revision: 0,
      kind: 'automatic',
      summary: 'stale',
      work_state: {
        goal: 'x',
        completed: [],
        in_progress: [],
        next_steps: [],
        blockers: [],
        decisions: [],
        changed_files: [],
        commands: [],
        tests: [],
      },
    },
  );
  check(
    'a stale expected revision is refused with 409',
    staleCheckpoint.status === 409 &&
      (staleCheckpoint.body as { error: { code: string } }).error.code ===
        'QUEST_REVISION_CONFLICT',
    staleCheckpoint.body,
  );

  const ended = await api.post<{ session: { state: string }; handoff: { kind: string } }>(
    `/api/sessions/${firstSession.body.session_id}/end`,
    {
      handoff: {
        expected_quest_revision: 1,
        summary: 'Stopping for the day; the endpoint is not wired yet',
        work_state: {
          goal: 'Add CSV report export',
          completed: ['Implemented CSV serialization', 'Added unit tests'],
          in_progress: ['Wiring the API endpoint'],
          next_steps: ['Wire POST /v1/reports/export', 'Add an integration test'],
          blockers: [
            {
              description: 'The report service lacks a streaming interface',
              suggested_action: 'Add ReportService.stream() first',
            },
          ],
          decisions: [{ decision: 'Stream rather than buffer', reason: 'Reports can be large' }],
          changed_files: [{ path: 'services/api/src/reports/csv.ts', current_hash: 'sha256:abc' }],
          commands: [{ command: 'pnpm test:unit', status: 'succeeded' }],
          tests: [{ name: 'csv serialization', status: 'passed' }],
        },
      },
    },
  );
  check(
    'the session ends with a final handoff',
    ended.body.handoff.kind === 'final_handoff',
    ended.body,
  );

  const unrelatedSession = await api.post<{ session_id: string }>('/api/sessions', {
    project: projectId,
    client: 'codex',
  });
  const unrelated = await api.post<{
    activation_mode: string;
    quest: { id: string };
    context: { continuation: unknown };
  }>(`/api/sessions/${unrelatedSession.body.session_id}/activate`, {
    task: 'Fix the login page layout',
  });
  check(
    'an unrelated new session does not inherit the handoff',
    unrelated.body.context.continuation === null && unrelated.body.quest.id !== questId,
    unrelated.body,
  );

  const resumeSession = await api.post<{ session_id: string }>('/api/sessions', {
    project: projectId,
    client: 'codex',
  });
  const resumed = await api.post<{
    activation_mode: string;
    quest: { id: string; revision: number };
    context: {
      continuation: {
        next_steps: string[];
        blockers: { description: string }[];
        recovered_from_interrupted_session: boolean;
        rendered: string;
      } | null;
    };
  }>(`/api/sessions/${resumeSession.body.session_id}/activate`, {
    task: 'Continue the CSV report export work',
    requested_quest_id: questId,
  });
  check('an explicit resume attaches the same Quest', resumed.body.quest.id === questId);
  check('resume mode is reported', resumed.body.activation_mode === 'resume_work');
  check(
    'the handoff next steps are loaded',
    resumed.body.context.continuation?.next_steps.includes('Wire POST /v1/reports/export') === true,
    resumed.body.context.continuation,
  );
  check(
    'the blockers are loaded',
    resumed.body.context.continuation?.blockers[0]?.description.includes('streaming interface') ===
      true,
  );
  check(
    'the continuation is not labelled as recovered, because a clean handoff exists',
    resumed.body.context.continuation?.recovered_from_interrupted_session === false,
  );

  const board = await api.get<{ items: { id: string; status: string }[] }>(
    `/api/projects/${projectId}/quests`,
  );
  check('both Quests appear on the board', board.body.items.length === 2, board.body.items.length);

  section('Party — two agents, overlap, exclusive conflict, lease expiry');
  const partyStatusBefore = await api.get<{ mode: string }>(
    `/api/projects/${projectId}/party/status`,
  );
  const partyEnabled = partyStatusBefore.body.mode !== 'off';
  check('Party reports its configured mode', typeof partyStatusBefore.body.mode === 'string');

  if (partyEnabled) {
    const agentA = await api.post<{ session_id: string; agent_run_id: string }>('/api/sessions', {
      project: projectId,
      client: 'claude-code',
      workspace_key: 'machine-a:verify',
      workspace_label: 'machine-a:verify',
    });
    const questA = await api.post<{ quest: { id: string } }>(
      `/api/sessions/${agentA.body.session_id}/activate`,
      { task: 'Add the token-family migration', scope: { modules: ['packages/database'] } },
    );

    const agentB = await api.post<{ session_id: string; agent_run_id: string }>('/api/sessions', {
      project: projectId,
      client: 'codex',
      workspace_key: 'machine-a:verify',
      workspace_label: 'machine-a:verify',
    });
    const questB = await api.post<{ quest: { id: string } }>(
      `/api/sessions/${agentB.body.session_id}/activate`,
      { task: 'Add the report tables migration', scope: { modules: ['packages/database'] } },
    );

    check(
      'both sessions received their own agent run',
      agentA.body.agent_run_id !== null && agentB.body.agent_run_id !== agentA.body.agent_run_id,
    );

    const status = await api.get<{
      active_agents: { client: string }[];
      overlaps: { kind: string; severity: string; same_workspace: boolean }[];
    }>(`/api/projects/${projectId}/party/status`);
    // Earlier sections in this run also leave live agent runs behind, so the assertion is
    // that *these two* are present rather than an exact total.
    const clients = status.body.active_agents.map((entry) => entry.client);
    check(
      'Party shows both of these agent runs as active',
      clients.filter((client) => client === 'claude-code').length >= 1 &&
        clients.filter((client) => client === 'codex').length >= 1,
      clients,
    );
    check(
      'a shared workspace is reported as critical',
      status.body.overlaps.some(
        (overlap) => overlap.kind === 'workspace' && overlap.severity === 'critical',
      ),
      status.body.overlaps,
    );
    check(
      'the shared module is reported as an overlap',
      status.body.overlaps.some((overlap) => overlap.kind === 'module'),
      status.body.overlaps.map((o) => o.kind),
    );

    const claimBody = {
      resource_type: 'migration_sequence',
      resource_key: 'packages/database/migrations',
      mode: 'exclusive',
    };
    const claimA = await api.post<{ claim: { id: string; state: string } }>('/api/party/claims', {
      ...claimBody,
      agent_run_id: agentA.body.agent_run_id,
      work_item_id: questA.body.quest.id,
    });
    check('the first exclusive claim is granted', claimA.status === 201, claimA.body);

    const claimB = await api.post('/api/party/claims', {
      ...claimBody,
      agent_run_id: agentB.body.agent_run_id,
      work_item_id: questB.body.quest.id,
    });
    const conflict = (claimB.body as { error: { code: string; details: Record<string, unknown> } })
      .error;
    check('the second exclusive claim is refused with 409', claimB.status === 409, claimB.body);
    check(
      'the conflict names the owning Quest and lease',
      conflict?.details?.owner_quest_title !== undefined &&
        conflict?.details?.lease_expires_at !== undefined,
      conflict?.details,
    );

    // Agent B stops without ending cleanly: its lease is left to expire.
    const heartbeat = await api.post<{ renewed_claims: number }>(
      `/api/party/runs/${agentA.body.agent_run_id}/heartbeat`,
      {},
    );
    check(
      'a heartbeat renews the run and its claims',
      heartbeat.body.renewed_claims === 1,
      heartbeat.body,
    );

    const released = await api.post<{ claim: { state: string } }>(
      `/api/party/claims/${claimA.body.claim.id}/release`,
      { agent_run_id: agentA.body.agent_run_id, reason: 'verification run' },
    );
    check('releasing a claim frees the resource', released.body.claim.state === 'released');

    // `claim` is optional because the body is whatever came back: a conflict answers with an
    // error envelope and no claim at all, which is exactly what the guards below defend against.
    const afterRelease = await api.post<{ claim?: { id: string; state: string } }>(
      '/api/party/claims',
      {
        ...claimBody,
        agent_run_id: agentB.body.agent_run_id,
        work_item_id: questB.body.quest.id,
      },
    );
    check(
      'the other agent can now take the resource',
      afterRelease.body.claim?.state === 'active',
      afterRelease.body,
    );

    const revoked = await api.post<{ claim: { state: string } }>(
      `/api/party/claims/${afterRelease.body.claim?.id ?? 'missing'}/revoke`,
      { reason: 'verification run', confirm: true },
    );
    check(
      'an administrator can revoke a claim with a reason',
      revoked.body.claim?.state === 'revoked',
      revoked.body,
    );

    const auditAfter = await api.get<{ items: { action: string }[] }>('/api/shrine/audit?limit=40');
    check(
      'the revocation is in the audit log',
      auditAfter.body.items.some((entry) => entry.action === 'party.claim_revoked'),
    );
  }

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
  check(
    'agent token issued with a raw value once',
    typeof tokenResponse.body.raw_token === 'string',
  );
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
  createdProjects.push(otherProject.body.project.id);
  const crossProject = await agent.get(`/api/projects/${otherProject.body.project.id}`);
  check(
    'a project-scoped token cannot reach another project',
    crossProject.status === 404,
    crossProject.body,
  );

  const agentOperate = await agent.post('/api/shrine/jobs/probe', {});
  check('an agent token cannot operate Shrine', agentOperate.status === 403, agentOperate.body);
}

async function main(): Promise<number> {
  const api = new ScriptClient(BASE_URL);
  try {
    await verify(api);
  } finally {
    await archiveCreatedProjects(api);
  }
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
