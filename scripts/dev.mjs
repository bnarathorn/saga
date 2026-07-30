#!/usr/bin/env node
// `pnpm dev` — runs the package build watcher, the API, the worker and the Guild Hall dev
// server together, and shuts them all down as a group so a stray process cannot keep the
// API port bound.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const targets = [
  // `tsx watch` compiles the app sources it loads, but `@saga/*` resolves through the package
  // exports to `dist`, so without this the API and worker run current route code against
  // whatever the domain packages last compiled to — editing `packages/lore/src` would appear to
  // do nothing. Keeping `tsc -b --watch` alongside closes the loop: a package edit rewrites
  // `dist`, and `tsx watch` reloads because `dist` is among the files it already loaded.
  // Consequence worth knowing: every package save now restarts the API and the worker.
  {
    name: 'build',
    command: 'pnpm',
    args: ['exec', 'tsc', '-b', 'apps/server', 'apps/worker', '--watch', '--preserveWatchOutput'],
    color: '\x1b[33m',
  },
  { name: 'api', command: 'pnpm', args: ['--filter', '@saga/server', 'dev'], color: '[36m' },
  { name: 'worker', command: 'pnpm', args: ['--filter', '@saga/worker', 'dev'], color: '[35m' },
  { name: 'web', command: 'pnpm', args: ['--filter', '@saga/web', 'dev'], color: '[32m' },
];

const children = [];
let shuttingDown = false;

for (const target of targets) {
  // `detached` puts each child in its own process group so shutdown can signal the whole
  // group. Signalling the child alone reaches only `pnpm`, which does not forward to the
  // `sh -c tsx watch …` grandchild actually holding the port — so a SIGTERM left the API
  // and Vite running. Ctrl-C appeared to work only because the terminal signals every
  // process in the foreground group itself.
  const child = spawn(target.command, target.args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: true,
  });
  children.push({ ...target, child });

  const prefix = `${target.color}[${target.name}][0m `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited (code=${code} signal=${signal}); stopping the rest\n`);
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    // Negative pid = the child's process group. It may already be gone, which throws ESRCH.
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 2_000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
