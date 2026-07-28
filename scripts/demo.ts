#!/usr/bin/env tsx
/**
 * The reproducible end-to-end demonstration from section 25 of the specification.
 *
 * It drives the *real* MCP tool handlers against a running Saga stack, from a temporary
 * plain folder with no version control at all, and prints each step. Nothing here is mocked:
 * the same code path an agent takes through `saga mcp` is exercised.
 *
 *   scripts/stack.sh up
 *   pnpm demo
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SagaClient } from '@saga/agent-sdk';
import { errorMessage, isSagaError } from '@saga/shared';
import { loadDotEnv } from '@saga/shared/dotenv';
import { TOOLS, type McpToolContext } from '../apps/cli/src/mcp/server.js';
import { detectWorkspace } from '../apps/cli/src/workspace.js';
import { ScriptClient } from './lib/http-client.js';

loadDotEnv();

const BASE_URL =
  process.env.SAGA_VERIFY_URL ?? `http://127.0.0.1:${process.env.SAGA_API_PORT ?? 4319}`;
const ADMIN_EMAIL = process.env.SAGA_BOOTSTRAP_ADMIN_EMAIL ?? 'admin@saga.local';
const ADMIN_PASSWORD = process.env.SAGA_BOOTSTRAP_ADMIN_PASSWORD ?? '';

const out = process.stdout;
let step = 0;

function heading(title: string): void {
  step += 1;
  out.write(`\n${'─'.repeat(72)}\n${String(step).padStart(2, ' ')}. ${title}\n${'─'.repeat(72)}\n`);
}

function detail(label: string, value: unknown): void {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  out.write(`   ${label}: ${rendered.split('\n').join('\n      ')}\n`);
}

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Unknown MCP tool: ${name}`);
  return found;
}

async function main(): Promise<number> {
  if (ADMIN_PASSWORD.length === 0) {
    throw new Error('Set SAGA_BOOTSTRAP_ADMIN_PASSWORD in .env, then run `scripts/stack.sh up`.');
  }

  const unique = Date.now().toString(36);
  const projectName = `ERP Backoffice ${unique}`;

  heading('Start PostgreSQL, the Saga API, the worker and Guild Hall');
  const live = await fetch(`${BASE_URL}/health/live`).catch(() => null);
  if (live === null || !live.ok) {
    throw new Error(`Saga is not running at ${BASE_URL}. Run: scripts/stack.sh up`);
  }
  detail('api', `${BASE_URL} is live`);

  heading('Sign in as the administrator');
  const console_ = new ScriptClient(BASE_URL);
  await console_.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  detail('signed in as', ADMIN_EMAIL);

  heading(`Create the project "${projectName}" in Guild Hall`);
  const created = await console_.post<{ project: { id: string; name: string } }>('/api/projects', {
    name: projectName,
  });
  const projectId = created.body.project.id;
  detail('project id', projectId);

  heading('Run `saga connect` from a plain folder with no version control');
  const folder = mkdtempSync(join(tmpdir(), 'saga-demo-'));
  writeFileSync(
    join(folder, 'README.md'),
    '# ERP Backoffice\n\nOrder and invoice management for the back office.\n',
  );
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({ name: 'erp-backoffice', scripts: { dev: 'node server.js' } }, null, 2),
  );
  const workspace = detectWorkspace(folder);
  detail('folder', folder);
  detail('detected project type', workspace.kind);
  detail('workspace label', workspace.workspaceLabel);
  if (workspace.kind !== 'plain') throw new Error('Expected a plain folder with no VCS.');

  heading('Issue a project-scoped agent token (what the device flow ends with)');
  const token = await console_.post<{ raw_token: string }>(`/api/projects/${projectId}/tokens`, {
    name: 'demo agent',
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
  detail('token prefix', `${token.body.raw_token.slice(0, 18)}…`);

  // From here on, everything runs through the real MCP tool handlers.
  const context: McpToolContext = {
    client: new SagaClient({
      baseUrl: BASE_URL,
      token: token.body.raw_token,
      client: 'claude-code',
    }),
    session: {
      sessionId: null,
      agentRunId: null,
      questId: null,
      questRevision: 0,
      projectRef: projectId,
      client: 'claude-code',
    },
    workspace: {
      root: workspace.root,
      kind: workspace.kind,
      workspaceKey: workspace.workspaceKey,
      workspaceLabel: workspace.workspaceLabel,
    },
  };

  heading('saga_start_session — short Core Context, bootstrap_required=true');
  const started = (await tool('saga_start_session').handler({ agent: 'claude' }, context)) as {
    bootstrap_required: boolean;
    core_context: string;
    bootstrap_plan: { proposed_keys: { memory_key: string }[] } | null;
  };
  detail('bootstrap required', started.bootstrap_required);
  detail('core context length', started.core_context.length);
  detail(
    'bootstrap plan suggests',
    started.bootstrap_plan?.proposed_keys.slice(0, 4).map((entry) => entry.memory_key) ?? [],
  );

  heading('The agent proposes initial Lore from local evidence');
  const remembered = (await tool('saga_remember').handler(
    {
      summary: 'Record initial project knowledge from local files',
      entries: [
        {
          memory_key: 'project.overview',
          category: 'overview',
          kind: 'fact',
          body: 'An ERP back office for order and invoice management.',
          evidence: [{ path: 'README.md' }],
          confidence: 0.9,
          verification_state: 'observed',
          importance: 95,
        },
        {
          memory_key: 'run.local',
          category: 'running',
          kind: 'procedure',
          body: 'Start the server with `node server.js` (the `dev` script in package.json).',
          data: { commands: ['node server.js'] },
          evidence: [{ path: 'package.json' }],
          confidence: 0.8,
          verification_state: 'inferred',
        },
        {
          memory_key: 'warning.production-data',
          category: 'warning',
          kind: 'warning',
          body: 'Never run the seed script against a production database.',
          confidence: 1,
          verification_state: 'verified',
          importance: 100,
        },
      ],
    },
    context,
  )) as { update_id: string; approval_mode: string };
  detail('update', remembered.update_id);
  detail('approval mode', remembered.approval_mode);

  heading('The worker validates, embeds, builds a snapshot and publishes');
  const published = await waitFor('the Lore update to publish', async () => {
    const update = await context.client.loreUpdate(remembered.update_id);
    return update.update.state === 'published' ? update.update : null;
  });
  detail('update state', published.state);

  const entries = await console_.get<{ items: { memory_key: string }[]; memory_revision: number }>(
    `/api/projects/${projectId}/lore`,
  );
  detail('Guild Hall shows revision', entries.body.memory_revision);
  detail(
    'entries',
    entries.body.items.map((entry) => entry.memory_key),
  );

  heading('Start the task "Add CSV report export"');
  const activated = (await tool('saga_activate_task').handler(
    {
      task: 'Add CSV report export',
      scope: { modules: ['services/api/src/reports'] },
    },
    context,
  )) as {
    activation_mode: string;
    quest: { id: string; title: string; revision: number };
    context: { task: string | null; continuation: unknown };
  };
  detail('activation mode', activated.activation_mode);
  detail('quest', `${activated.quest.title} (revision ${activated.quest.revision})`);
  detail('continuation loaded', activated.context.continuation);
  detail('task context', (activated.context.task ?? '').split('\n').slice(0, 3).join('\n'));

  heading('The agent records a checkpoint');
  const checkpoint = (await tool('saga_checkpoint').handler(
    {
      kind: 'milestone',
      summary: 'Implemented the CSV generator and unit tests',
      work_state: {
        goal: 'Add CSV report export',
        completed: ['Implemented CSV serialization'],
        in_progress: ['Add the API endpoint'],
        next_steps: ['Wire POST /v1/reports/export to the report service'],
        blockers: [],
        decisions: [],
        changed_files: [{ path: 'services/api/src/reports/csv.ts', current_hash: 'sha256:aaa' }],
        commands: [{ command: 'pnpm test:unit', status: 'succeeded' }],
        tests: [{ name: 'csv serialization', status: 'passed' }],
      },
    },
    context,
  )) as { quest_revision: number };
  detail('quest revision', checkpoint.quest_revision);

  heading('End the session with a final handoff');
  const ended = (await tool('saga_end_session').handler(
    {
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
        changed_files: [{ path: 'services/api/src/reports/csv.ts', current_hash: 'sha256:bbb' }],
        commands: [],
        tests: [],
      },
    },
    context,
  )) as { handoff_id: string; quest_revision: number; released_claims: number };
  detail('handoff', ended.handoff_id);
  detail('released claims', ended.released_claims);

  const questId = activated.quest.id;

  heading('Open a new session and explicitly resume the Quest');
  await tool('saga_start_session').handler({ agent: 'codex' }, context);
  const resumed = (await tool('saga_activate_task').handler(
    { task: 'Continue the CSV report export work', requested_quest_id: questId },
    context,
  )) as {
    activation_mode: string;
    context: {
      continuation: {
        next_steps: string[];
        blockers: { description: string }[];
        rendered: string;
      } | null;
    };
  };
  detail('activation mode', resumed.activation_mode);
  detail('next steps', resumed.context.continuation?.next_steps ?? []);
  detail('blockers', resumed.context.continuation?.blockers.map((b) => b.description) ?? []);

  heading('Start another agent on another Quest, in the same folder');
  const second: McpToolContext = {
    ...context,
    client: new SagaClient({ baseUrl: BASE_URL, token: token.body.raw_token, client: 'codex' }),
    session: {
      ...context.session,
      sessionId: null,
      agentRunId: null,
      questId: null,
      questRevision: 0,
      client: 'codex',
    },
  };
  await tool('saga_start_session').handler({ agent: 'codex' }, second);
  await tool('saga_activate_task').handler(
    { task: 'Add the invoice totals migration', scope: { modules: ['packages/database'] } },
    second,
  );

  const party = await console_.get<{
    active_agents: { client: string; quest_title: string | null }[];
    overlaps: { kind: string; severity: string }[];
  }>(`/api/projects/${projectId}/party/status`);
  detail(
    'Party shows',
    party.body.active_agents.map((agent) => `${agent.client} → ${agent.quest_title ?? 'no Quest'}`),
  );
  detail(
    'overlaps',
    party.body.overlaps.map((overlap) => `${overlap.severity}: ${overlap.kind}`),
  );

  heading('Both agents attempt an exclusive claim on the same migration sequence');
  const claimA = (await tool('saga_claim_resource').handler(
    { resource_type: 'migration_sequence', resource_key: 'db/migrations', mode: 'exclusive' },
    context,
  )) as { claim: { id: string; state: string } };
  detail('first claim', `${claimA.claim.state} (${claimA.claim.id})`);

  try {
    await tool('saga_claim_resource').handler(
      { resource_type: 'migration_sequence', resource_key: 'db/migrations', mode: 'exclusive' },
      second,
    );
    throw new Error('The second claim should have been refused.');
  } catch (error) {
    if (!isSagaError(error) || error.code !== 'RESOURCE_CLAIM_CONFLICT') throw error;
    detail('second claim', `refused — ${error.code}`);
    detail('conflict details', error.details);
  }

  heading('Stop one agent without ending cleanly; its lease expires');
  // Nothing is called on `second`: the agent simply stops. Its lease will lapse and the
  // worker's party reaper will expire the run and release its claims.
  detail('note', 'The second agent is abandoned deliberately — no clean end is performed.');
  const runs = await console_.get<{ items: { client: string; live: boolean; state: string }[] }>(
    `/api/projects/${projectId}/party/runs`,
  );
  detail(
    'agent runs',
    runs.body.items.map((run) => `${run.client}: ${run.state}${run.live ? ' (live)' : ''}`),
  );

  heading('Shrine shows service, job, health and event state throughout');
  const health = await console_.get<{ status: string; checks: { name: string; status: string }[] }>(
    '/api/shrine/health',
  );
  detail('health', health.body.status);
  detail('checks', health.body.checks.map((check) => `${check.name}=${check.status}`).join(' '));

  const metrics = await console_.get<{ metrics: Record<string, unknown> }>(
    '/api/shrine/metrics-summary',
  );
  detail('metrics', metrics.body.metrics);

  const events = await console_.get<{ items: { event_type: string; message: string }[] }>(
    `/api/shrine/events?project_id=${projectId}&limit=12`,
  );
  out.write('\n   Recent events:\n');
  for (const event of events.body.items.reverse()) {
    out.write(`      ${event.event_type.padEnd(28)} ${event.message}\n`);
  }

  out.write(
    `\n${'─'.repeat(72)}\nDemonstration complete.\n` +
      `  Project:    ${projectName}\n` +
      `  Folder:     ${folder} (plain, no version control)\n` +
      `  Guild Hall: ${process.env.SAGA_PUBLIC_URL ?? 'http://localhost:4320'}\n\n`,
  );

  return 0;
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Create a scratch folder with a couple of high-signal files for bootstrap to read. */
export function seedDemoFolder(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Demo project\n');
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`\n${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);
