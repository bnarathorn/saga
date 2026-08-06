import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SagaError } from '@saga/shared';
import { CLI_VERSION } from '../version.js';
import { detectWorkspace, findBinding, loadConfig } from '../workspace.js';
import { parseFlags } from './connect.js';

const run = promisify(execFile);

/** The shebang every build carries. A response that lacks it is not the CLI. */
const SHEBANG = '#!/usr/bin/env node';

/** Smaller than any real build (the bundle is ~760 KB); a truncated download must not install. */
const MIN_PLAUSIBLE_BYTES = 100_000;

/**
 * `saga update` — replace this executable with the build the server is serving.
 *
 * The server hands out the CLI at `GET /api/cli/saga`, unauthenticated, and that build is by
 * definition the one matching the running API. Updating is therefore a download and a rename,
 * with two things that must not be skipped: what arrives is checked before it replaces
 * anything, and the replacement is verified by running it, because the one command a broken
 * CLI takes away is the command that would fix it.
 */
export async function updateCommand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const json = flags.json === true;
  const check = argv.includes('--check');
  const force = argv.includes('--force');

  const config = loadConfig();
  const serverUrl =
    flags.server ??
    process.env.SAGA_SERVER_URL ??
    findBinding(config, detectWorkspace().root)?.serverUrl ??
    config.serverUrl ??
    null;

  if (serverUrl === null) {
    throw new SagaError(
      'NOT_FOUND',
      'No Saga server is configured for this folder. Pass --server, or run `saga connect` first.',
    );
  }

  const target = check ? null : installPath();
  const url = `${serverUrl.replace(/\/$/, '')}/api/cli/saga`;
  assertTransportIsTrustworthy(url, argv.includes('--insecure'));

  const response = await fetch(url).catch(() => null);
  if (response === null || !response.ok) {
    throw new SagaError(
      'SERVICE_UNAVAILABLE',
      `Could not download the CLI from ${url}` +
        (response === null ? '.' : ` (HTTP ${String(response.status)}).`) +
        ' The installed CLI is untouched.',
    );
  }

  const available = response.headers.get('x-saga-cli-version') ?? 'unknown';
  const current = CLI_VERSION;
  const availableBuild = response.headers.get('x-saga-cli-build');
  const currentBuild = installedBuildDigest(target);
  // What identifies a build is its bytes, not its version. Comparing versions is what made this
  // command a no-op for a whole release: a pre-1.0 tree stamps every build `0.1.0`, so an
  // installed bundle from before a fix reported itself as already current. The version
  // comparison survives only for a server too old to send a digest, where it is the best
  // evidence available; `unknown` on either side is not evidence of sameness, so it downloads.
  const upToDate =
    availableBuild !== null && currentBuild !== null
      ? availableBuild === currentBuild
      : available !== 'unknown' && available === current;

  if (check || (upToDate && !force)) {
    // Nothing here reads the body, and an undrained one holds the connection open.
    await response.body?.cancel().catch(() => undefined);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ installed_version: current, available_version: available, installed_build: currentBuild, available_build: availableBuild, up_to_date: upToDate, installed_path: target, server: serverUrl }, null, 2)}\n`,
      );
    } else if (upToDate) {
      process.stdout.write(`saga ${current} is already the build ${serverUrl} is serving.\n`);
    } else if (available === current) {
      // Same number, different bytes. Saying only "serving 0.1.0" here would read as a no-op
      // and send the user away with the stale build they came to replace.
      process.stdout.write(
        `saga ${current} is installed; ${serverUrl} is serving a different build of ${available}.\n` +
          'Run `saga update` to install it.\n',
      );
    } else {
      process.stdout.write(
        `saga ${current} is installed; ${serverUrl} is serving ${available}.\n` +
          'Run `saga update` to install it.\n',
      );
    }
    return 0;
  }

  const downloaded = Buffer.from(await response.arrayBuffer());
  assertLooksLikeCli(downloaded, url);

  const installed = target!;
  const temporary = `${installed}.saga-update-${String(process.pid)}`;
  const backup = `${installed}.saga-backup-${String(process.pid)}`;

  try {
    // Written beside the target rather than in the system temp directory: rename is only
    // atomic within one filesystem, and /tmp is frequently a different one.
    writeFileSync(temporary, downloaded);
    chmodSync(temporary, 0o755);
    copyFileSync(installed, backup);
    // Replacing an inode a running process holds open is safe on Unix: this process keeps the
    // file it already mapped, and the next invocation gets the new one.
    renameSync(temporary, installed);
  } catch (error) {
    rmSync(temporary, { force: true });
    rmSync(backup, { force: true });
    throw writeFailure(error, installed);
  }

  const working = await verify(installed);
  if (!working) {
    renameSync(backup, installed);
    throw new SagaError(
      'SERVICE_UNAVAILABLE',
      `The downloaded CLI did not run, so ${installed} was restored from backup. ` +
        'Nothing else was changed. Report this with the server version if it repeats.',
    );
  }
  rmSync(backup, { force: true });

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ installed_path: installed, previous_version: current, previous_build: currentBuild, installed_version: available, installed_build: availableBuild, updated: true, server: serverUrl }, null, 2)}\n`,
    );
  } else {
    // Naming the same version on both sides of the arrow reads as though nothing happened, which
    // is the case a digest exists to catch — so that one names the build it just installed.
    const installedName =
      available === 'unknown'
        ? 'the build this server serves'
        : available === current && availableBuild !== null
          ? `${available} (build ${availableBuild.slice('sha256:'.length, 'sha256:'.length + 12)})`
          : available;
    process.stdout.write(`Updated ${installed}\n  ${current} → ${installedName}\n`);
  }
  return 0;
}

/**
 * The digest of the build this process is running from, in the form the server sends.
 *
 * Never fatal. `--check` from a development checkout has no installable path at all, and a
 * digest that cannot be read only costs the byte comparison — the caller falls back to versions,
 * which is what this command did before digests existed.
 */
function installedBuildDigest(target: string | null): string | null {
  try {
    const bytes = readFileSync(target ?? installPath());
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * The file this process is running from.
 *
 * `process.argv[1]` rather than `process.execPath`: the CLI is a bundled script run by Node, so
 * `execPath` is Node itself. A symlink is resolved, because `npm install -g` installs the bin
 * as a link into the same store the next update would otherwise leave stale.
 */
export function installPath(argv1: string | undefined = process.argv[1]): string {
  if (argv1 === undefined || argv1.length === 0) {
    throw new SagaError('NOT_FOUND', 'Could not determine which file this CLI is running from.');
  }

  const resolved = realpathSync(argv1);
  // A checkout runs from source through a loader; overwriting a source file with a bundle would
  // be destructive in a way no update should ever be.
  if (resolved.endsWith('.ts') || resolved.includes(`${join('node_modules', '.bin')}`)) {
    throw new SagaError(
      'BAD_REQUEST',
      `This CLI is running from ${resolved}, which is a development checkout rather than an ` +
        'installed build. Update it with git and `pnpm --filter @saga/cli bundle` instead.',
    );
  }
  return resolved;
}

/**
 * Refuse to install what an unencrypted connection returned.
 *
 * Every other command sends a token over the same connection and risks that token; this one
 * takes what comes back, marks it executable and runs it. Over plain HTTP anyone on the path
 * chooses what this machine executes, and `saga doctor` reporting the URL as a warning is not
 * a safeguard against that. Loopback is exempt because nothing is on the path, which keeps the
 * development stack (`http://localhost:4319`) working.
 */
function assertTransportIsTrustworthy(url: string, allowInsecure: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SagaError('BAD_REQUEST', `"${url}" is not a valid server URL.`);
  }

  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1';
  if (parsed.protocol === 'https:' || loopback || allowInsecure) return;

  throw new SagaError(
    'FORBIDDEN',
    `Refusing to install an executable downloaded over ${parsed.protocol}//. ` +
      'Anyone on the network path could choose what this machine runs. Use the HTTPS URL for ' +
      'this server, or pass --insecure if you genuinely trust this network.',
  );
}

function assertLooksLikeCli(body: Buffer, url: string): void {
  const head = body.subarray(0, SHEBANG.length).toString('utf8');
  if (head !== SHEBANG || body.byteLength < MIN_PLAUSIBLE_BYTES) {
    throw new SagaError(
      'SERVICE_UNAVAILABLE',
      `What ${url} returned is not a Saga CLI build (${String(body.byteLength)} bytes). ` +
        'The installed CLI is untouched. A proxy or captive portal answering for the server ' +
        'is the usual cause.',
    );
  }
}

/** A build that cannot report its own version is a build that must not be left installed. */
async function verify(path: string): Promise<boolean> {
  return run(path, ['--version'], { timeout: 20_000 }).then(
    ({ stdout }) => stdout.trim().length > 0,
    () => false,
  );
}

function writeFailure(error: unknown, installed: string): SagaError {
  const code = (error as { code?: string }).code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new SagaError(
      'FORBIDDEN',
      `${installed} is not writable by this user, so nothing was changed. ` +
        `Re-run with elevated privileges, or install the CLI somewhere you own: ` +
        `curl -fsSL <server>/api/cli/saga -o ~/.local/bin/saga && chmod +x ~/.local/bin/saga`,
    );
  }
  return new SagaError(
    'SERVICE_UNAVAILABLE',
    `Could not replace ${installed}: ${error instanceof Error ? error.message : 'unknown error'}. ` +
      'The installed CLI is untouched.',
  );
}
