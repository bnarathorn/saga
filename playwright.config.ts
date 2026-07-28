import { defineConfig, devices } from '@playwright/test';
import { API_URL, stackEnv, WEB_PORT, WEB_URL } from './tests/e2e/stack-env.js';

/**
 * Browser tests for Guild Hall. They run against a real API, a real worker and a real
 * database — the point of this suite is exactly the wiring the component tests mock out.
 *
 * The stack runs on its own ports so it cannot collide with `scripts/stack.sh`, and it uses
 * the test database without truncating it: every fixture the suite creates is uniquely named.
 *
 * The worker is started by `tests/e2e/global-setup.ts` rather than here, because a
 * `webServer` entry must own a port and the worker does not listen on one.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // `prepare` migrates and empties the database before the server reads it — see the
      // comment in tests/e2e/prepare.ts for why that ordering is load-bearing.
      command:
        'node --import tsx tests/e2e/prepare.ts && node --import tsx apps/server/src/main.ts',
      url: `${API_URL}/health/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: stackEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @saga/web dev',
      url: WEB_URL,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { SAGA_API_URL: API_URL, SAGA_WEB_PORT: String(WEB_PORT) },
    },
  ],
});
