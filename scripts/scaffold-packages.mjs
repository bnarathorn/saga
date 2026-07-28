#!/usr/bin/env node
// Generates package.json + tsconfig.json for every workspace package from a single
// declarative spec so that dependency direction and TypeScript project references
// can never drift apart.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Dependency direction (a package may only depend on packages listed before it):
 * shared -> contracts -> database -> core -> shrine -> quest -> lore -> party -> agent-sdk
 */
const packages = [
  {
    dir: 'packages/shared',
    name: '@saga/shared',
    description: 'Cross-cutting Saga primitives: errors, logging, config, time, redaction.',
    internal: [],
    deps: { pino: '^9.6.0', zod: '^3.24.1' },
  },
  {
    dir: 'packages/contracts',
    name: '@saga/contracts',
    description: 'Shared Zod request/response contracts and OpenAPI generation for Saga.',
    internal: ['@saga/shared'],
    deps: { zod: '^3.24.1', '@asteasolutions/zod-to-openapi': '^7.3.0' },
  },
  {
    dir: 'packages/database',
    name: '@saga/database',
    description: 'PostgreSQL pool, explicit transactions, advisory locks and the migration runner.',
    internal: ['@saga/shared'],
    deps: { pg: '^8.13.1' },
    devDeps: { '@types/pg': '^8.11.10' },
  },
  {
    dir: 'packages/core',
    name: '@saga/core',
    description: 'Project identity, aliases and the transactional outbox.',
    internal: ['@saga/shared', '@saga/contracts', '@saga/database'],
    deps: { zod: '^3.24.1', '@node-rs/argon2': '^2.0.2' },
  },
  {
    dir: 'packages/shrine',
    name: '@saga/shrine',
    description: 'Operational domain: service instances, job queue, system events and health.',
    internal: ['@saga/shared', '@saga/contracts', '@saga/database', '@saga/core'],
    deps: { zod: '^3.24.1' },
  },
  {
    dir: 'packages/quest',
    name: '@saga/quest',
    description: 'Work items, sessions, checkpoints and handoffs.',
    internal: ['@saga/shared', '@saga/contracts', '@saga/database', '@saga/core', '@saga/shrine'],
    deps: { zod: '^3.24.1' },
  },
  {
    dir: 'packages/lore',
    name: '@saga/lore',
    description: 'Durable project knowledge: memory items, versions, updates, search and context.',
    internal: [
      '@saga/shared',
      '@saga/contracts',
      '@saga/database',
      '@saga/core',
      '@saga/shrine',
      '@saga/quest',
    ],
    deps: { zod: '^3.24.1' },
  },
  {
    dir: 'packages/party',
    name: '@saga/party',
    description: 'Live agent coordination: agent runs, resources, leases and claims.',
    internal: [
      '@saga/shared',
      '@saga/contracts',
      '@saga/database',
      '@saga/core',
      '@saga/shrine',
      '@saga/quest',
    ],
    deps: { zod: '^3.24.1' },
  },
  {
    dir: 'packages/agent-sdk',
    name: '@saga/agent-sdk',
    description: 'Typed HTTP client for agent integrations that do not use MCP.',
    internal: ['@saga/shared', '@saga/contracts'],
    deps: { zod: '^3.24.1' },
  },
  {
    dir: 'apps/server',
    name: '@saga/server',
    description: 'Saga Fastify API server.',
    bin: null,
    main: 'dist/main.js',
    internal: [
      '@saga/shared',
      '@saga/contracts',
      '@saga/database',
      '@saga/core',
      '@saga/shrine',
      '@saga/quest',
      '@saga/lore',
      '@saga/party',
    ],
    deps: {
      fastify: '^5.2.1',
      '@fastify/cookie': '^11.0.2',
      '@fastify/cors': '^10.0.2',
      '@fastify/helmet': '^13.0.1',
      '@fastify/rate-limit': '^10.2.2',
      '@fastify/static': '^8.0.4',
      zod: '^3.24.1',
    },
    scripts: {
      dev: 'tsx watch --clear-screen=false src/main.ts',
      start: 'node dist/main.js',
    },
  },
  {
    dir: 'apps/worker',
    name: '@saga/worker',
    description: 'Saga background worker process.',
    main: 'dist/main.js',
    internal: [
      '@saga/shared',
      '@saga/contracts',
      '@saga/database',
      '@saga/core',
      '@saga/shrine',
      '@saga/quest',
      '@saga/lore',
      '@saga/party',
    ],
    deps: { zod: '^3.24.1' },
    scripts: {
      dev: 'tsx watch --clear-screen=false src/main.ts',
      start: 'node dist/main.js',
    },
  },
  {
    dir: 'apps/cli',
    name: '@saga/cli',
    description: 'The `saga` command line interface and MCP stdio server.',
    main: 'dist/main.js',
    bin: { saga: 'dist/main.js' },
    internal: ['@saga/shared', '@saga/contracts', '@saga/agent-sdk'],
    deps: {
      '@modelcontextprotocol/sdk': '^1.13.0',
      zod: '^3.24.1',
    },
    scripts: {
      dev: 'tsx src/main.ts',
    },
  },
];

for (const pkg of packages) {
  const abs = join(root, pkg.dir);
  mkdirSync(join(abs, 'src'), { recursive: true });

  const dependencies = { ...(pkg.deps ?? {}) };
  for (const name of pkg.internal) dependencies[name] = 'workspace:*';

  const pkgJson = {
    name: pkg.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: pkg.description,
    main: pkg.main ?? './dist/index.js',
    types: pkg.main ? undefined : './dist/index.d.ts',
    exports: pkg.main
      ? undefined
      : {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './*': { types: './dist/*.d.ts', default: './dist/*.js' },
        },
    ...(pkg.bin ? { bin: pkg.bin } : {}),
    scripts: {
      build: 'tsc -b',
      clean: 'tsc -b --clean',
      ...(pkg.scripts ?? {}),
    },
    dependencies: Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    ...(pkg.devDeps ? { devDependencies: pkg.devDeps } : {}),
  };

  writeFileSync(join(abs, 'package.json'), `${JSON.stringify(pkgJson, null, 2)}\n`);

  const refDirs = pkg.internal.map((name) => {
    const dep = packages.find((p) => p.name === name);
    if (!dep) throw new Error(`Unknown internal dependency ${name} in ${pkg.name}`);
    // The explicit `tsconfig.json` suffix, rather than the directory, because tools other
    // than `tsc` (Playwright's config loader among them) do not expand a directory here.
    return `${relative(abs, join(root, dep.dir)).replaceAll('\\', '/')}/tsconfig.json`;
  });

  const tsconfig = {
    extends: relative(abs, join(root, 'tsconfig.base.json')).replaceAll('\\', '/'),
    compilerOptions: {
      rootDir: 'src',
      outDir: 'dist',
      tsBuildInfoFile: 'dist/.tsbuildinfo',
      types: ['node'],
    },
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts', 'src/testing/**'],
    references: refDirs.map((path) => ({ path })),
  };

  writeFileSync(join(abs, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
}

console.log(`scaffolded ${packages.length} workspace packages`);
