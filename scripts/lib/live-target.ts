/**
 * Target resolution and credentials for the two scripts that drive a *running* stack:
 * `scripts/verify.ts` and `scripts/demo.ts`. Both write, and both take their target from a
 * port rather than a deployment, which is what made the 2026-08-13 accident possible — see
 * the "Live verification" section of `docs/testing.md`.
 *
 * Everything here is a function rather than a module-level constant on purpose. Imports are
 * evaluated before the importing module's body runs, so a constant would read `process.env`
 * before the caller's `loadDotEnv()` had a chance to populate it.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function resolveBaseUrl(): string {
  return process.env.SAGA_VERIFY_URL ?? `http://127.0.0.1:${process.env.SAGA_API_PORT ?? 4319}`;
}

export function resolveAdminEmail(): string {
  return (
    process.env.SAGA_VERIFY_ADMIN_EMAIL ??
    process.env.SAGA_BOOTSTRAP_ADMIN_EMAIL ??
    'admin@saga.local'
  );
}

/**
 * The default target is a port, not a deployment: `SAGA_API_PORT` is 4319 in a developer's
 * `.env` and 4319 in the systemd reference deployment too. On a host running both, a script
 * started with no stack up reaches production, signs in with the bootstrap administrator and
 * leaves its fixtures behind — which is exactly what happened on 2026-08-13. The readiness
 * probe names the deployment, so refuse before the first write rather than after.
 *
 * A server that reports no environment at all is refused as well: that is indistinguishable
 * from a production instance predating the field.
 */
export function assertDisposableTarget(
  baseUrl: string,
  readiness: { environment?: string },
  leaves: string,
): void {
  if (process.env.SAGA_VERIFY_ALLOW_PRODUCTION === '1') return;
  if (readiness.environment === undefined) {
    throw new Error(
      `${baseUrl} does not report an environment on /health/ready, so this script cannot tell ` +
        'a scratch stack from production. Update the server, or set ' +
        'SAGA_VERIFY_ALLOW_PRODUCTION=1 if you accept that it will leave fixtures behind.',
    );
  }
  if (readiness.environment === 'production') {
    throw new Error(
      `${baseUrl} is a production deployment. This script creates ${leaves}. Point ` +
        'SAGA_VERIFY_URL at a scratch stack, or set SAGA_VERIFY_ALLOW_PRODUCTION=1 to override ' +
        'deliberately.',
    );
  }
}

/**
 * Reads a secret without echoing it. `terminal: true` makes readline echo each keystroke to
 * its output, so the output here is a sink that forwards the prompt and then drops everything
 * — which is the echo.
 */
async function readSecret(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      if (!muted) process.stdout.write(chunk, typeof chunk === 'string' ? encoding : undefined);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = rl.question(prompt);
    muted = true;
    return await answer;
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

/**
 * The administrator password is a credential, so neither script requires it to sit in `.env`.
 * A password on disk beside `SAGA_API_PORT` is what let the accidental run authenticate against
 * production; `assertDisposableTarget` stops such a run reaching production at all, and this
 * stops the credential lying around for the next one.
 *
 * Order: `SAGA_VERIFY_ADMIN_PASSWORD` for a deliberate inline or CI run, then
 * `SAGA_BOOTSTRAP_ADMIN_PASSWORD` for anyone who does keep it in `.env`, then an interactive
 * prompt. Without a TTY there is nothing to prompt, so say what to set instead.
 */
export async function resolveAdminPassword(baseUrl: string, email: string): Promise<string> {
  const fromEnv =
    process.env.SAGA_VERIFY_ADMIN_PASSWORD ?? process.env.SAGA_BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (fromEnv.length > 0) return fromEnv;

  if (!process.stdin.isTTY) {
    throw new Error(
      'No administrator password and no terminal to ask for one. Set ' +
        `SAGA_VERIFY_ADMIN_PASSWORD for ${email} on ${baseUrl}, or run this from a terminal.`,
    );
  }

  const entered = await readSecret(`Password for ${email} on ${baseUrl}: `);
  if (entered.length === 0) throw new Error('No password entered.');
  return entered;
}
