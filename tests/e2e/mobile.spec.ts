import { expect, request, test, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, API_URL } from './stack-env.js';

/**
 * Guild Hall on a phone.
 *
 * The whole console is one narrow column at this width, and the failure it guards against is
 * always the same shape: a box that cannot shrink — a data table, a filter bar, a panel header,
 * a definition list holding a UUID — pushes the document wider than the viewport, and every
 * page then scrolls sideways as a whole. A table wider than the screen is fine and expected;
 * it scrolls inside its own container. The *document* must not.
 *
 * Fixtures are created through the API rather than the browser: what is being asserted is
 * layout, and an empty table has no rows to overflow with.
 */

const RUN = Date.now().toString(36);
const PROJECT = `E2E Mobile ${RUN}`;
const MEMORY_KEY = 'run.mobile.viewport';

// A 390x844 viewport is the narrow end of current phones; anything narrower is a rounding
// difference rather than a different layout.
test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ mode: 'serial' });

let projectId = '';
let questId = '';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

/**
 * The document's own width, plus the widest box that already exceeds the viewport on its own —
 * so a failure names the element to fix instead of only the number of pixels.
 */
async function horizontalOverflow(page: Page): Promise<{ overflow: number; culprit: string }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const overflow = root.scrollWidth - root.clientWidth;
    let culprit = 'none';
    if (overflow > 1) {
      const widest = Array.from(document.querySelectorAll('body *'))
        .map((el) => ({ el, right: el.getBoundingClientRect().right }))
        .filter(({ el, right }) => {
          if (right <= root.clientWidth + 1) return false;
          // A scroll container is allowed to hold something wider than the screen; its
          // children are its own business, not the page's.
          for (let node = el.parentElement; node !== null; node = node.parentElement) {
            const overflowX = getComputedStyle(node).overflowX;
            if (overflowX === 'auto' || overflowX === 'scroll') return false;
          }
          return true;
        })
        .sort((a, b) => b.right - a.right)[0];
      if (widest !== undefined) {
        const el = widest.el;
        culprit = `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} right=${Math.round(widest.right)}`;
      }
    }
    return { overflow, culprit };
  });
}

test('fixtures: a project with Lore, a Quest, a plan and a handoff', async () => {
  const api = await request.newContext({ baseURL: API_URL });
  const login = await api.post('/api/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const csrf = ((await login.json()) as { csrf_token: string }).csrf_token;

  const created = await api.post('/api/projects', {
    headers: { 'x-saga-csrf': csrf },
    data: { name: PROJECT },
  });
  expect(created.status(), await created.text()).toBe(201);
  projectId = ((await created.json()) as { project: { id: string } }).project.id;

  const issued = await api.post(`/api/projects/${projectId}/tokens`, {
    headers: { 'x-saga-csrf': csrf },
    data: {
      name: `e2e mobile agent ${RUN}`,
      scopes: ['project:read', 'lore:read', 'lore:propose', 'quest:read', 'quest:write'],
    },
  });
  expect(issued.status(), await issued.text()).toBe(201);
  const token = ((await issued.json()) as { raw_token: string }).raw_token;
  await api.dispose();

  const agent = await request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });

  const started = await agent.post('/api/sessions', {
    data: {
      project: projectId,
      client: 'claude-code',
      agent: 'claude',
      workspace_label: `machine-e2e-mobile:${RUN}`,
    },
  });
  const sessionId = ((await started.json()) as { session_id: string }).session_id;

  const activated = await agent.post(`/api/sessions/${sessionId}/activate`, {
    data: {
      task: 'Read the Quest Board on a phone',
      // Long unbreakable strings are the point: a path has no space to wrap at.
      scope: { files: ['apps/web/src/components/primitives.tsx'], modules: ['apps/web/src/pages'] },
    },
  });
  const activatedBody = (await activated.json()) as { quest: { id: string; revision: number } };
  questId = activatedBody.quest.id;

  const planned = await agent.put(`/api/quests/${questId}/plan`, {
    data: { steps: ['Measure the overflow', 'Fix what cannot shrink'] },
  });
  expect(planned.ok(), await planned.text()).toBeTruthy();

  const workState = {
    goal: 'Read the Quest Board on a phone',
    completed: ['Measured every route at 390px'],
    in_progress: ['Fixing the panel headers'],
    next_steps: ['Re-measure'],
    blockers: [],
    decisions: [],
    changed_files: [{ path: 'apps/web/src/components/primitives.tsx' }],
    commands: [{ command: 'pnpm test:e2e', status: 'succeeded' as const }],
    tests: [],
  };
  // Declaring the plan is itself a revision, so the checkpoint follows the Quest's current one
  // rather than assuming activation left it at zero.
  const quest = await agent.get(`/api/quests/${questId}`);
  const revision = ((await quest.json()) as { quest: { revision: number } }).quest.revision;
  const handoff = await agent.post(`/api/sessions/${sessionId}/checkpoints`, {
    data: {
      expected_quest_revision: revision,
      kind: 'final_handoff',
      summary: 'Handing off with the measurements recorded',
      work_state: workState,
    },
  });
  expect(handoff.status(), await handoff.text()).toBe(201);

  const remembered = await agent.post(`/api/projects/${projectId}/lore/remember`, {
    data: {
      summary: `Record ${MEMORY_KEY}`,
      entries: [
        {
          memory_key: MEMORY_KEY,
          category: 'running',
          kind: 'procedure',
          body: 'Guild Hall is read on a phone as well as a desktop, so no page scrolls sideways.',
          confidence: 0.9,
          verification_state: 'observed',
        },
      ],
    },
  });
  expect(remembered.status(), await remembered.text()).toBe(202);
  await agent.dispose();
});

test('no page scrolls sideways at 390px', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect((await horizontalOverflow(page)).overflow, 'the login page').toBeLessThanOrEqual(1);

  await signIn(page);

  const project = (suffix = ''): string => `/projects/${encodeURIComponent(PROJECT)}${suffix}`;
  const routes: [string, string][] = [
    ['the Dashboard', '/'],
    ['the Projects list', '/projects'],
    ['a project overview', project('')],
    ['Lore', project('/lore')],
    ['a Lore Entry', project(`/lore/${MEMORY_KEY}`)],
    ['the Quest Board', project('/quests')],
    ['a Quest', project(`/quests/${questId}`)],
    ['the Party', project('/party')],
    ['Relations', project('/relations')],
    ['Activity', project('/activity')],
    ['the Shrine', project('/shrine')],
    ['the token list', project('/tokens')],
    ['the device approval', '/device?code=WXYZ-1234'],
  ];

  for (const [what, route] of routes) {
    await page.goto(route);
    // Every one of these pages has a heading of its own; waiting for it is what makes the
    // measurement land on rendered content rather than on a spinner.
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect
      .poll(async () => (await horizontalOverflow(page)).overflow, {
        message: `${what} (${route}) scrolls sideways`,
      })
      .toBeLessThanOrEqual(1);
    const { overflow, culprit } = await horizontalOverflow(page);
    expect(overflow, `${what} (${route}) overflows: ${culprit}`).toBeLessThanOrEqual(1);
  }
});

test('a table wider than the phone scrolls inside its panel, not the page', async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${encodeURIComponent(PROJECT)}/lore`);

  const scroller = page.locator('div.overflow-x-auto', { has: page.locator('table') }).first();
  await expect(scroller).toBeVisible();
  // The Lore table carries six columns, so it is wider than the viewport by design.
  const measured = await scroller.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(measured.scrollWidth).toBeGreaterThan(measured.clientWidth);
  expect((await horizontalOverflow(page)).overflow).toBeLessThanOrEqual(1);
});

test('the shell stays usable: navigation, project picker and sign-out are all reachable', async ({
  page,
}) => {
  await signIn(page);

  const nav = page.getByRole('navigation', { name: 'Primary' });
  // Nothing in the header may be pushed off-screen at this width, so each control is asserted
  // to be inside the viewport rather than merely present in the DOM.
  for (const control of [
    nav.getByRole('link', { name: 'Dashboard' }),
    nav.getByRole('combobox', { name: 'Project' }),
    page.getByRole('button', { name: 'Sign out' }),
  ]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
  }

  await nav.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: PROJECT })).toBeVisible();
});
