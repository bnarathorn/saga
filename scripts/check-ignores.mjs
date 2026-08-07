#!/usr/bin/env node
/**
 * Guards the two invariants that tie `.dockerignore` to `.gitignore`.
 *
 * Both were broken in production and neither was caught by anything cheap:
 *
 *   1. A path git tracks must never be excluded from the build context. `.env.*` once matched the
 *      tracked `.env.example`, so `git status` inside the build stage reported a deleted file,
 *      `apps/cli/scripts/bundle.mjs` read that as a dirty tree, and every image served
 *      `0.1.0+g<sha>.dirty.<stamp>`. CI caught it only after a full `docker build`, and the error
 *      pointed at the symptom rather than the pattern.
 *
 *   2. A path git ignores should not enter the build context either. Nothing caught this at all:
 *      a CI checkout has no `coverage/`, `.vite/` or `.claude/`, so images built on a developer's
 *      machine quietly carried that developer's files while CI stayed green.
 *
 * `.dockerignore` patterns are not `.gitignore` patterns — a bare `coverage/` matches the context
 * root and nothing below it — so the two files cannot simply be diffed as text.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths `.gitignore` ignores that are deliberately left in the build context. Add an entry only
 * with a reason: every one of these is a file a developer has and an image will therefore carry.
 */
const ALLOWED_IN_CONTEXT = new Map([
  // `.git` is not in `.gitignore`, so it never reaches this check — it is named here only so the
  // deliberate exception is written down in one place. `bundle.mjs` reads the commit from it.
]);

/** Read an ignore file into `{ pattern, negated }`, dropping comments and blanks. */
function readIgnoreFile(name) {
  const raw = readFileSync(join(repoRoot, name), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const body = negated ? line.slice(1) : line;
      return { pattern: body.replace(/^\.?\//, '').replace(/\/$/, ''), negated, source: line };
    })
    .filter((rule) => rule.pattern.length > 0);
}

/**
 * Compile one Docker ignore pattern to a regex over a slash-separated path.
 *
 * `**` spans zero or more whole segments; `*` and `?` never cross a `/`.
 */
function patternToRegex(pattern) {
  const parts = pattern.split('/');
  let source = '';
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === '**') {
      source += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    for (const char of part) {
      if (char === '*') source += '[^/]*';
      else if (char === '?') source += '[^/]';
      else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    if (!last) source += '/';
  });
  return new RegExp(`^${source}$`);
}

/**
 * Does this rule cover this path? A pattern naming a directory covers everything beneath it, so
 * every ancestor prefix is tested too.
 */
function ruleMatches(regex, path) {
  if (regex.test(path)) return true;
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    if (regex.test(segments.slice(0, i).join('/'))) return true;
  }
  return false;
}

/** Docker applies every rule in order and the last match wins, negations included. */
function isExcluded(path, rules) {
  let excluded = false;
  for (const rule of rules) {
    if (ruleMatches(rule.regex, path)) excluded = !rule.negated;
  }
  return excluded;
}

/**
 * A path that stands in for a `.gitignore` pattern. `*` becomes a literal so the sample is a real
 * path; an unanchored pattern (no interior `/`) also gets a nested form, because `.gitignore`
 * applies those at every level while `.dockerignore` does not.
 */
function samplePaths(pattern) {
  const base = pattern.replace(/\*/g, 'x');
  const anchored = pattern.includes('/');
  const bases = anchored ? [base] : [base, `nested/dir/${base}`];
  return bases.flatMap((path) => [path, `${path}/probe.txt`]);
}

const dockerRules = readIgnoreFile('.dockerignore').map((rule) => ({
  ...rule,
  regex: patternToRegex(rule.pattern),
}));
const gitRules = readIgnoreFile('.gitignore');

const failures = [];

// --- 1. No tracked path may be excluded ------------------------------------------------------
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter((line) => line.length > 0);

for (const path of tracked) {
  if (isExcluded(path, dockerRules)) {
    failures.push(
      `.dockerignore excludes the tracked path "${path}". The build stage would see it as ` +
        `deleted and stamp the CLI dirty. Negate it with "!${path}" or narrow the pattern.`,
    );
  }
}

// The one deliberate inclusion, and the reason the build stage can stamp a commit at all.
if (isExcluded('.git/HEAD', dockerRules)) {
  failures.push(
    '.dockerignore excludes .git, so bundle.mjs cannot read the commit and every image would ' +
      'serve 0.1.0+local.<wall clock> instead of 0.1.0+g<sha>.',
  );
}

// --- 2. Every ignored path should stay out of the context ------------------------------------
for (const rule of gitRules) {
  if (rule.negated || ALLOWED_IN_CONTEXT.has(rule.pattern)) continue;
  const uncovered = samplePaths(rule.pattern).filter((path) => !isExcluded(path, dockerRules));
  if (uncovered.length > 0) {
    failures.push(
      `.gitignore ignores "${rule.source}" but .dockerignore lets it into the build context ` +
        `(e.g. ${uncovered[0]}). Add a matching entry — remember .dockerignore needs the "**/" ` +
        `prefix to match below the root — or allowlist it in ALLOWED_IN_CONTEXT with a reason.`,
    );
  }
}

if (failures.length > 0) {
  console.error('.dockerignore and .gitignore disagree:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `.dockerignore is consistent with .gitignore: ${tracked.length} tracked paths all reach the ` +
    `build context, ${gitRules.length} ignore rules all stay out of it.`,
);
