import { defineConfig } from 'vitest/config';
import { sagaAliases } from './vitest.shared.js';

/**
 * Test projects:
 *   unit         pure logic, no external services
 *   integration  real PostgreSQL (SAGA_TEST_DATABASE_URL)
 *   api          full Fastify app against real PostgreSQL
 *   web          Guild Hall components in jsdom
 */
export default defineConfig({
  resolve: { alias: sagaAliases },
  test: {
    projects: [
      {
        resolve: { alias: sagaAliases },
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/cli/src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        resolve: { alias: sagaAliases },
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.integration.test.ts', 'db/**/*.integration.test.ts'],
          environment: 'node',
          globalSetup: ['./testing/global-setup.ts'],
          hookTimeout: 60_000,
          testTimeout: 60_000,
          // One fork for the whole project: these suites truncate shared tables between
          // tests, so two files running at once would wipe each other's fixtures.
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
        },
      },
      {
        resolve: { alias: sagaAliases },
        test: {
          name: 'api',
          include: ['apps/server/src/**/*.api.test.ts'],
          environment: 'node',
          globalSetup: ['./testing/global-setup.ts'],
          hookTimeout: 60_000,
          testTimeout: 60_000,
          // One fork for the whole project: these suites truncate shared tables between
          // tests, so two files running at once would wipe each other's fixtures.
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
        },
      },
      './apps/web/vite.config.ts',
    ],
  },
});
