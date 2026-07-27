#!/usr/bin/env node
// `pnpm dev` — runs the API, the worker and the Guild Hall dev server together, and shuts
// all three down as a group so a stray process cannot keep the API port bound.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const targets = [
  { name: 'api', command: 'pnpm', args: ['--filter', '@saga/server', 'dev'], color: '[36m' },
  { name: 'worker', command: 'pnpm', args: ['--filter', '@saga/worker', 'dev'], color: '[35m' },
  { name: 'web', command: 'pnpm', args: ['--filter', '@saga/web', 'dev'], color: '[32m' },
];

const children = [];
let shuttingDown = false;

for (const target of targets) {
  const child = spawn(target.command, target.args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
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
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 2_000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
