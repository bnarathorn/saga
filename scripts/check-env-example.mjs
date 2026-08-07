#!/usr/bin/env node
/**
 * Guards that `.env.example` documents every environment variable the config surface reads.
 *
 * `SAGA_E2E_DATABASE_URL` was missing from it for as long as the variable existed. CI never
 * noticed, because `.github/workflows/ci.yml` sets it as a workflow-level `env:` entry — so the
 * only person the gap ever reached was someone setting up locally from the example, and the
 * failure was silent: `tests/e2e/stack-env.ts` falls back to `SAGA_TEST_DATABASE_URL`, and the
 * e2e stack then empties the database the integration and api suites are using.
 *
 * Only the config surface is scanned, not the whole tree. Variables that belong to a developer's
 * machine (`XDG_*`), to the CLI talking to a remote server (`SAGA_SERVER_URL`), or to the build
 * (`SAGA_CLI_BUILD_ID`) are not server configuration and have no place in this file.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Files whose environment reads are server, worker or suite configuration. */
const CONFIG_SURFACE = [
  'packages/shared/src/config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
];
const CONFIG_SURFACE_DIRS = ['tests'];

/**
 * Variables the config surface reads that `.env.example` deliberately omits. Each needs a reason,
 * because the default of a variable a developer must set is a broken local setup.
 */
const NOT_DEVELOPER_CONFIGURATION = new Map([
  ['CI', 'Set by the CI runner itself; nothing a developer configures.'],
]);

/** Every environment-variable read this file can see, in any of the shapes the repo uses. */
const READ_PATTERNS = [
  /\benv\.([A-Z][A-Z0-9_]*)\b/g, // the config.ts mapping: env.SAGA_API_PORT
  /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g, // process.env.DATABASE_URL
  /\bprocess\.env\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]/g, // process.env['DATABASE_URL']
  /\benv\(\s*['"`]([A-Z][A-Z0-9_]*)['"`]/g, // helper form: env('SAGA_E2E_DATABASE_URL', ...)
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(full)) out.push(full);
  }
  return out;
}

const files = [
  ...CONFIG_SURFACE.map((path) => join(repoRoot, path)),
  ...CONFIG_SURFACE_DIRS.flatMap((dir) => {
    try {
      return walk(join(repoRoot, dir));
    } catch {
      return [];
    }
  }),
];

/** variable name -> the file that reads it, for the error message. */
const required = new Map();
for (const file of files) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    continue; // An optional member of the config surface that this checkout does not have.
  }
  for (const pattern of READ_PATTERNS) {
    for (const match of contents.matchAll(pattern)) {
      if (!required.has(match[1])) required.set(match[1], relative(repoRoot, file));
    }
  }
}

const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
const documented = new Set(
  example
    .split('\n')
    .map((line) => line.trim().replace(/^#\s*/, ''))
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name) => name !== undefined),
);

const missing = [...required.entries()]
  .filter(([name]) => !documented.has(name) && !NOT_DEVELOPER_CONFIGURATION.has(name))
  .sort(([a], [b]) => a.localeCompare(b));

if (missing.length > 0) {
  console.error('.env.example does not document every variable the config surface reads:\n');
  for (const [name, file] of missing) {
    console.error(`  - ${name}, read by ${file}`);
  }
  console.error(
    '\nAdd each to .env.example with a working default, or list it in ' +
      'NOT_DEVELOPER_CONFIGURATION with a reason.\n',
  );
  process.exit(1);
}

console.log(
  `.env.example documents all ${required.size - NOT_DEVELOPER_CONFIGURATION.size} configuration ` +
    `variables read across ${files.length} config-surface files.`,
);
