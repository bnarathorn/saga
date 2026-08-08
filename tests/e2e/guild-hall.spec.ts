import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, API_URL } from './stack-env.js';

/**
 * The end-to-end browser scenario of specification section 21.4, in order:
 *
 *   1. an administrator logs in                7. Quest Board shows the Quest and handoff
 *   2. they create a project                   8. Party shows an active Agent Run
 *   3. Guild Hall shows the Lore bootstrap     9. a failed job fixture is created
 *   4. a Lore Entry is proposed and published 10. the administrator retries it from the Dashboard
 *   5. an agent starts a session              11. the audit log records the retry
 *   6. it records a checkpoint
 *
 * Steps 5, 6, 8 and 9 use the API the way an agent or fixture would; everything a human does
 * goes through the browser.
 */

const RUN = Date.now().toString(36);
const PROJECT = `E2E Guild Hall ${RUN}`;
const MEMORY_KEY = 'run.api.local';
const RETRY_REASON = `e2e retry ${RUN}`;

test.describe.configure({ mode: 'serial' });

/** An API client authenticated as the bootstrap administrator, for fixtures only. */
async function adminApi(): Promise<{ api: APIRequestContext; csrf: string }> {
  const api = await request.newContext({ baseURL: API_URL });
  const login = await api.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const body = (await login.json()) as { csrf_token: string };
  return { api, csrf: body.csrf_token };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The primary navigation only exists once a session is established: the "Guild Hall"
  // heading is on the login page too, so it would pass before authentication.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

const projectPath = (suffix = ''): string => `/projects/${encodeURIComponent(PROJECT)}${suffix}`;

let projectId = '';
let agentToken = '';
let sessionId = '';
let failedJobId = '';

test('1-2: an administrator logs in and creates a project', async ({ page }) => {
  await signIn(page);

  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByLabel('New project').fill(PROJECT);
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('link', { name: PROJECT })).toBeVisible();

  const { api, csrf } = await adminApi();
  const response = await api.get(`/api/projects/${encodeURIComponent(PROJECT)}`);
  const body = (await response.json()) as { project: { id: string; memory_revision: number } };
  projectId = body.project.id;
  // A project is created from a name alone, and starts with no Lore at all.
  expect(body.project.memory_revision).toBe(0);

  // Step 4 is a human approving a proposal, which only happens in `manual` mode: under the
  // default `auto` mode the worker publishes as soon as validation passes, and there is
  // nothing left for the browser to approve.
  const patched = await api.patch(`/api/projects/${projectId}`, {
    headers: { 'x-saga-csrf': csrf },
    data: { lore_approval_mode: 'manual' },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  await api.dispose();
});

test('3: Guild Hall shows the empty Lore bootstrap state', async ({ page }) => {
  await signIn(page);
  await page.goto(projectPath('/lore'));

  await expect(page.getByText('No Lore recorded yet')).toBeVisible();
  await expect(page.getByText(/saga connect/)).toBeVisible();
});

test('4: a Lore Entry is proposed and published from the browser', async ({ page }) => {
  await signIn(page);
  await page.goto(projectPath('/lore'));

  await page.getByRole('button', { name: 'Propose a Lore Entry' }).click();
  // Scoped to the form: the filter bar above it has a Category control of its own.
  const form = page.locator('form').filter({ has: page.getByLabel('Memory key') });
  await form.getByLabel('Memory key').fill(MEMORY_KEY);
  await form.getByLabel('Category', { exact: true }).selectOption('running');
  await form.getByLabel('Kind', { exact: true }).selectOption('procedure');
  await form
    .getByLabel('Body')
    .fill('Start PostgreSQL before the API, then run pnpm --filter api dev.');
  await form.getByRole('button', { name: 'Propose' }).click();

  const proposal = page.getByRole('listitem').filter({ hasText: `Record ${MEMORY_KEY}` });
  await expect(proposal).toBeVisible();

  // draft -> validating -> ready -> published. The worker's validation job races the operator
  // to the first transition and usually wins, so the Validate button is clicked only while it
  // is still there; publication in `manual` mode is the browser's alone.
  const validate = proposal.getByRole('button', { name: 'Validate' });
  if (await validate.isVisible()) {
    await validate.click().catch(() => undefined);
  }
  const approve = proposal.getByRole('button', { name: 'Approve and publish' });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await approve.click();

  // Publication is what makes the entry current, so the table is the assertion.
  await expect(page.getByRole('link', { name: MEMORY_KEY })).toBeVisible();
  await expect(page.getByText('No Lore recorded yet')).toBeHidden();
});

test('5-6: an agent starts a session and records a checkpoint', async () => {
  const { api, csrf } = await adminApi();

  const issued = await api.post(`/api/projects/${projectId}/tokens`, {
    headers: { 'x-saga-csrf': csrf },
    data: {
      name: `e2e agent ${RUN}`,
      scopes: ['project:read', 'lore:read', 'quest:read', 'quest:write', 'party:heartbeat'],
    },
  });
  expect(issued.status(), await issued.text()).toBe(201);
  agentToken = ((await issued.json()) as { raw_token: string }).raw_token;
  await api.dispose();

  const agent = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${agentToken}` },
  });

  const started = await agent.post('/api/sessions', {
    data: {
      project: projectId,
      client: 'claude-code',
      agent: 'claude',
      workspace_label: `machine-e2e:${RUN}`,
    },
  });
  const startBody = (await started.json()) as { session_id: string; state: string };
  // Phase one attaches no Quest and loads no handoff.
  expect(startBody.state).toBe('awaiting_task');
  sessionId = startBody.session_id;

  const activated = await agent.post(`/api/sessions/${sessionId}/activate`, {
    data: { task: 'Add CSV report export', scope: { modules: ['services/api/src/reports'] } },
  });
  const activatedBody = (await activated.json()) as {
    activation_mode: string;
    quest: { id: string };
  };
  expect(activatedBody.activation_mode).toBe('new_work');
  expect(activatedBody.quest.id).toMatch(/^[0-9a-f-]{36}$/);

  const workState = {
    goal: 'Add CSV report export',
    completed: ['Implemented the CSV serializer'],
    in_progress: ['Wiring the API endpoint'],
    next_steps: ['Add the report route and its tests'],
    blockers: [],
    decisions: [],
    changed_files: [],
    commands: [],
    tests: [],
  };

  const checkpoint = await agent.post(`/api/sessions/${sessionId}/checkpoints`, {
    data: {
      expected_quest_revision: 0,
      kind: 'milestone',
      summary: 'Implemented the CSV generator',
      work_state: workState,
    },
  });
  expect((await checkpoint.json()).quest_revision).toBe(1);

  const handoff = await agent.post(`/api/sessions/${sessionId}/checkpoints`, {
    data: {
      expected_quest_revision: 1,
      kind: 'final_handoff',
      summary: 'Handing off before the endpoint is wired',
      work_state: workState,
    },
  });
  expect(handoff.status(), await handoff.text()).toBe(201);
  await agent.dispose();
});

test('7: Quest Board shows the Quest, and its detail shows the handoff', async ({ page }) => {
  await signIn(page);
  await page.goto(projectPath('/quests'));

  const board = page.getByRole('region', { name: 'In progress Quests' });
  await expect(board.getByRole('link', { name: /Add CSV report export/ })).toBeVisible();

  await board.getByRole('link', { name: /Add CSV report export/ }).click();
  await expect(page.getByText('Latest handoff')).toBeVisible();
  // The summary appears twice — in the handoff panel and in the checkpoint timeline below it.
  await expect(page.getByText('Handing off before the endpoint is wired').first()).toBeVisible();
  await expect(page.getByText('Wiring the API endpoint').first()).toBeVisible();
});

test('8: Party shows the agent run as live', async ({ page }) => {
  await signIn(page);
  await page.goto(projectPath('/party'));

  const agents = page.getByRole('region', { name: 'Party' }).or(page.locator('body'));
  // A run is named by its `agent_instance_id` — `${agent}:${session prefix}`, so `claude:…`
  // for the run seeded above. Never by `client`, which is the transport: every MCP session
  // reports the same one, so two agents in one workspace became one indistinguishable row.
  await expect(agents.getByText(/\bclaude:[0-9a-f]{8}\b/).first()).toBeVisible();
  await expect(page.getByText('live').first()).toBeVisible();
  await expect(page.getByText('Add CSV report export').first()).toBeVisible();

  // The transport must not be what identifies the run. This is the regression the naming
  // change exists to prevent, and asserting the new label alone would not catch a revert.
  await expect(page.locator('#main')).not.toContainText('claude-code');

  // A local absolute path is never exposed: only the sanitized label reaches the browser.
  // Scoped to the application content, because the Vite dev server injects module paths of
  // its own into the document head that have nothing to do with what the API returned.
  const rendered = await page.locator('#main').innerHTML();
  expect(rendered).not.toContain('/home/');
  expect(rendered).not.toContain(process.cwd());
});

test('every project tab resolves to its own page, not the not-found fallback', async ({ page }) => {
  await signIn(page);

  // Each tab is reached by clicking it, the way a user would: a tab whose route is missing
  // renders the fallback instead, which is exactly the failure this guards against.
  for (const [label, heading] of [
    ['Relations', 'Relations'],
    ['Activity', 'Activity'],
    ['Party', 'Party'],
    ['Shrine', 'Shrine'],
  ] as const) {
    await page.goto(projectPath(''));
    await page
      .getByRole('navigation', { name: 'Project sections' })
      .getByRole('link', {
        name: label,
      })
      .click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText('This project has no such section.')).toBeHidden();
  }
});

test('9-11: a failed job is retried from the Dashboard and recorded in the audit log', async ({
  page,
}) => {
  const { api, csrf } = await adminApi();

  const enqueued = await api.post('/api/shrine/jobs/probe', {
    headers: { 'x-saga-csrf': csrf },
    data: { fail: 'permanent', echo: `e2e-fail-${RUN}`, project_id: projectId },
  });
  expect(enqueued.status(), await enqueued.text()).toBe(201);
  failedJobId = ((await enqueued.json()) as { job: { id: string } }).job.id;

  // The worker drives it to `failed`; the browser only ever sees the result.
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/shrine/jobs/${failedJobId}`);
        return ((await response.json()) as { job: { state: string } }).job.state;
      },
      { timeout: 30_000, message: 'the probe job never reached its terminal state' },
    )
    .toBe('failed');
  await api.dispose();

  await signIn(page);
  // The server-wide queue lives on the Dashboard; the project's own Shrine tab shows the same
  // job filtered to this project, and either page can retry it.
  await page.goto('/');

  // The probe endpoint enqueues a `noop` job — "probe" names the operator action, not the type.
  const row = page.getByRole('row').filter({ hasText: 'noop' }).filter({ hasText: 'failed' });
  await expect(row.first()).toBeVisible();
  await row.first().getByRole('button', { name: 'Retry' }).click();

  // Every disruptive action requires a reason, and the reason is what lands in the audit log.
  await page.getByLabel(/Reason for retry/).fill(RETRY_REASON);
  await page.getByRole('button', { name: 'Confirm retry' }).click();

  const auditPanel = page.locator('section', { hasText: 'Audit log' }).last();
  await expect(auditPanel.getByText('shrine.job_retry').first()).toBeVisible();
  await expect(auditPanel.getByText(RETRY_REASON).first()).toBeVisible();
});
