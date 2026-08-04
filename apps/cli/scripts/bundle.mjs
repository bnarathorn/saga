#!/usr/bin/env node
// Builds the `saga` command as one self-contained executable, so a client machine can install it
// with a single `curl` instead of cloning this repository and running pnpm.
//
// The CLI depends on `@saga/shared`, `@saga/contracts` and `@saga/agent-sdk` at `workspace:*`,
// which npm cannot resolve outside this workspace, and all three are private. Bundling erases the
// question: esbuild inlines them, along with zod and the MCP SDK, so what comes out needs nothing
// from a registry at all.
//
//   pnpm --filter @saga/cli bundle
//
// leaves two things in apps/cli/pack:
//
//   dist/saga                  the executable the API serves at /api/cli/saga
//   saga-cli-<version>.tgz     the same file wrapped for `npm install -g`
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packDir = join(cliRoot, 'pack');
const manifest = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));

// A stale pack directory is worse than none: npm pack would happily ship last release's files
// alongside this one's.
rmSync(packDir, { recursive: true, force: true });
mkdirSync(join(packDir, 'dist'), { recursive: true });

// No extension, because the whole point is that a client can save this as ~/.local/bin/saga and
// run it. That is also why the output is CommonJS: an extensionless file with no package.json
// beside it is CommonJS to Node, so ESM output would fail outright on Node 22.0–22.6 and survive
// on 22.12+ only by module-syntax detection. Nothing in src/main.ts needs ESM — it has no
// top-level await, and its one dynamic import is inlined here.
const bundlePath = join(packDir, 'dist', 'saga');

execFileSync(
  'esbuild',
  [
    join(cliRoot, 'src', 'main.ts'),
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=cjs',
    `--outfile=${bundlePath}`,
    '--legal-comments=none',
    '--log-level=warning',
  ],
  { cwd: cliRoot, stdio: 'inherit' },
);

chmodSync(bundlePath, 0o755);

// Deliberately not `@saga/cli`: this package is installed from a URL, never from a registry, and
// claiming a scope we do not own on npm invites a name collision that would be someone else's
// package on a client machine.
writeFileSync(
  join(packDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'saga-cli',
      version: manifest.version,
      description: manifest.description,
      bin: { saga: 'dist/saga' },
      files: ['dist', 'README.md'],
      engines: { node: '>=22' },
      private: false,
    },
    null,
    2,
  )}\n`,
);

cpSync(join(cliRoot, 'scripts', 'pack-readme.md'), join(packDir, 'README.md'));

execFileSync('npm', ['pack', '--silent'], { cwd: packDir, stdio: 'inherit' });

process.stdout.write(
  `\n${bundlePath}\n${join(packDir, `saga-cli-${manifest.version}.tgz`)}\n\n` +
    `The API serves the first of those at /api/cli/saga once this build is in place, so a\n` +
    `client needs no repository and no package manager:\n\n` +
    `  mkdir -p ~/.local/bin\n` +
    `  curl -fsSL https://<your-server>/api/cli/saga -o ~/.local/bin/saga\n` +
    `  chmod +x ~/.local/bin/saga\n\n` +
    `The tarball is for anyone who would rather npm owned the install. It is the same file:\n` +
    `  npm install -g ./saga-cli-${manifest.version}.tgz\n`,
);
