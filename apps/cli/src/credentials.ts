import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type CredentialBackend =
  | 'keychain'
  | 'secret-service'
  | 'wincred'
  | 'file'
  | 'environment';

export interface CredentialStoreStatus {
  backend: CredentialBackend;
  available: boolean;
  detail: string;
}

const SERVICE = 'saga-cli';

function envToken(): string | null {
  const value = process.env.SAGA_TOKEN;
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * Token storage.
 *
 * The operating-system keychain is preferred. When none is available the token falls back to
 * a 0600 file — and `saga doctor` says so plainly, because a user is entitled to know their
 * credential is on disk rather than in a keychain.
 */
export class CredentialStore {
  private backendCache: CredentialBackend | null = null;

  /** Where the token this process will use actually comes from. */
  async backend(): Promise<CredentialBackend> {
    // An explicit environment token bypasses storage entirely (CI and containers), so it is
    // the backend — reporting it as the file store would tell the user to do what they did.
    if (envToken() !== null) return 'environment';
    return this.storageBackend();
  }

  /** Where a token would be written to or read from on this machine, ignoring SAGA_TOKEN. */
  private async storageBackend(): Promise<CredentialBackend> {
    if (this.backendCache !== null) return this.backendCache;
    this.backendCache = await this.detect();
    return this.backendCache;
  }

  private async detect(): Promise<CredentialBackend> {
    const os = platform();
    try {
      if (os === 'darwin') {
        await run('security', ['-h'], { timeout: 3_000 });
        return 'keychain';
      }
      if (os === 'linux') {
        await run('secret-tool', ['--version'], { timeout: 3_000 });
        return 'secret-service';
      }
      if (os === 'win32') {
        return 'wincred';
      }
    } catch {
      // No keychain tool on PATH; fall through to the file backend.
    }
    return 'file';
  }

  async status(): Promise<CredentialStoreStatus> {
    const backend = await this.backend();
    switch (backend) {
      case 'environment':
        return {
          backend,
          available: true,
          detail: 'SAGA_TOKEN from the environment. Nothing is read from or written to storage.',
        };
      case 'keychain':
        return { backend, available: true, detail: 'macOS Keychain via `security`.' };
      case 'secret-service':
        return { backend, available: true, detail: 'Secret Service via `secret-tool`.' };
      case 'wincred':
        return { backend, available: true, detail: 'Windows Credential Manager.' };
      default:
        return {
          backend,
          available: true,
          detail: `No OS keychain found. Tokens are stored in ${this.filePath()} with mode 0600. Install libsecret-tools (Linux) for keychain storage, or set SAGA_TOKEN for CI.`,
        };
    }
  }

  private filePath(): string {
    const base =
      process.env.XDG_DATA_HOME !== undefined && process.env.XDG_DATA_HOME.length > 0
        ? process.env.XDG_DATA_HOME
        : join(homedir(), '.local', 'share');
    return join(base, 'saga', 'credentials.json');
  }

  private accountFor(serverUrl: string): string {
    return serverUrl.replace(/\/$/, '');
  }

  async get(serverUrl: string): Promise<string | null> {
    // CI and non-interactive environments win over stored credentials.
    const fromEnv = envToken();
    if (fromEnv !== null) return fromEnv;

    const account = this.accountFor(serverUrl);
    const backend = await this.storageBackend();

    try {
      if (backend === 'keychain') {
        const { stdout } = await run(
          'security',
          ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
          { timeout: 5_000 },
        );
        return stdout.trim() || null;
      }
      if (backend === 'secret-service') {
        const { stdout } = await run(
          'secret-tool',
          ['lookup', 'service', SERVICE, 'account', account],
          { timeout: 5_000 },
        );
        return stdout.trim() || null;
      }
      if (backend === 'wincred') {
        const { stdout } = await run(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `$c = Get-StoredCredential -Target '${SERVICE}:${account}' -ErrorAction SilentlyContinue; if ($c) { $c.GetNetworkCredential().Password }`,
          ],
          { timeout: 8_000 },
        );
        return stdout.trim() || null;
      }
    } catch {
      // Not found, or the tool failed: fall through to the file backend so a partially
      // configured machine still works.
    }

    return this.readFileToken(account);
  }

  async set(serverUrl: string, token: string): Promise<CredentialBackend> {
    const account = this.accountFor(serverUrl);
    // Storing is about the machine, not about this process: SAGA_TOKEN must not divert a
    // token away from the keychain it belongs in.
    const backend = await this.storageBackend();

    try {
      if (backend === 'keychain') {
        await run(
          'security',
          ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', token],
          { timeout: 5_000 },
        );
        return backend;
      }
      if (backend === 'secret-service') {
        await new Promise<void>((resolvePromise, reject) => {
          const child = execFile(
            'secret-tool',
            ['store', '--label', `Saga (${account})`, 'service', SERVICE, 'account', account],
            (error) => (error === null ? resolvePromise() : reject(error)),
          );
          child.stdin?.end(token);
        });
        return backend;
      }
      if (backend === 'wincred') {
        await run(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `New-StoredCredential -Target '${SERVICE}:${account}' -UserName saga -Password '${token.replace(/'/g, "''")}' -Persist LocalMachine | Out-Null`,
          ],
          { timeout: 8_000 },
        );
        return backend;
      }
    } catch {
      // Storing failed; fall back to the file so the user is not left unauthenticated.
    }

    this.writeFileToken(account, token);
    return 'file';
  }

  async clear(serverUrl: string): Promise<void> {
    const account = this.accountFor(serverUrl);
    const backend = await this.storageBackend();
    try {
      if (backend === 'keychain') {
        await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account], {
          timeout: 5_000,
        });
      } else if (backend === 'secret-service') {
        await run('secret-tool', ['clear', 'service', SERVICE, 'account', account], {
          timeout: 5_000,
        });
      }
    } catch {
      // Nothing stored under that account; the file backend is cleared below regardless.
    }

    const path = this.filePath();
    if (!existsSync(path)) return;
    const store = this.readFileStore();
    delete store[account];
    if (Object.keys(store).length === 0) unlinkSync(path);
    else writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  }

  private readFileStore(): Record<string, string> {
    const path = this.filePath();
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private readFileToken(account: string): string | null {
    return this.readFileStore()[account] ?? null;
  }

  private writeFileToken(account: string, token: string): void {
    const path = this.filePath();
    mkdirSync(dirname(path), { recursive: true });
    const store = this.readFileStore();
    store[account] = token;
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Some filesystems do not support chmod; the warning in `doctor` covers it.
    }
  }
}
