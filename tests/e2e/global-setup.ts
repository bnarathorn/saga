import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stackEnv } from './stack-env.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Starts the worker for the duration of the suite. Playwright's `webServer` cannot own it:
 * the worker listens on no port, and every `webServer` entry is identified by its URL.
 *
 * Returns its own teardown, so a failing run still stops the process.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const worker: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/worker/src/main.ts'],
    {
      cwd: ROOT,
      env: { ...process.env, ...stackEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so the kill below reaches any grandchild too.
      detached: true,
    },
  );

  worker.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[worker] ${chunk.toString()}`);
  });

  const exited = new Promise<never>((_resolve, reject) => {
    worker.once('exit', (code) => {
      reject(new Error(`The e2e worker exited early with code ${String(code)}.`));
    });
  });

  // Give it a moment to fail loudly (bad database URL, schema mismatch) rather than to fail
  // silently in the middle of a test that is waiting for a job.
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);

  return async () => {
    if (worker.pid !== undefined && worker.exitCode === null) {
      try {
        process.kill(-worker.pid, 'SIGTERM');
      } catch {
        worker.kill('SIGTERM');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  };
}
