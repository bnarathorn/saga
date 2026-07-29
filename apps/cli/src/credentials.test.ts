import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore } from './credentials.js';

/**
 * Token storage (spec 13.2).
 *
 * `SAGA_TOKEN` is set in every test that does not explicitly clear it, which pins the backend
 * to the file store: these assertions must not depend on whether the machine running them has
 * `secret-tool` or `security` installed.
 */

const SERVER = 'https://saga.example.internal';
let data: string;
const originalEnv = { ...process.env };

function filePath(): string {
  return join(data, 'saga', 'credentials.json');
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'saga-cred-'));
  process.env.XDG_DATA_HOME = data;
  process.env.SAGA_TOKEN = '';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('CredentialStore', () => {
  it('lets SAGA_TOKEN win over anything stored, for CI and containers', async () => {
    const store = new CredentialStore();
    await store.set(SERVER, 'stored-token');

    process.env.SAGA_TOKEN = 'ci-token';
    expect(await new CredentialStore().get(SERVER)).toBe('ci-token');
  });

  it('round-trips a token through the file backend', async () => {
    const store = new CredentialStore();
    expect(await store.set(SERVER, 'token-1')).toBe('file');
    expect(await new CredentialStore().get(SERVER)).toBe('token-1');
  });

  it('writes the credential file with owner-only permissions', async () => {
    await new CredentialStore().set(SERVER, 'token-1');
    // 0600: a token on disk must not be readable by other users on the machine.
    expect(statSync(filePath()).mode & 0o777).toBe(0o600);
  });

  it('keeps one token per server rather than one for the machine', async () => {
    const store = new CredentialStore();
    await store.set(SERVER, 'token-a');
    await store.set('https://other.internal', 'token-b');

    expect(await store.get(SERVER)).toBe('token-a');
    expect(await store.get('https://other.internal')).toBe('token-b');
  });

  it('treats a trailing slash as the same server', async () => {
    const store = new CredentialStore();
    await store.set(`${SERVER}/`, 'token-1');
    expect(await store.get(SERVER)).toBe('token-1');
  });

  it('returns null for a server it has never seen', async () => {
    expect(await new CredentialStore().get('https://unknown.internal')).toBeNull();
  });

  it('removes the file entirely once the last token is cleared', async () => {
    const store = new CredentialStore();
    await store.set(SERVER, 'token-1');
    await store.clear(SERVER);

    expect(await store.get(SERVER)).toBeNull();
    expect(existsSync(filePath())).toBe(false);
  });

  it('clears one server without disturbing the others', async () => {
    const store = new CredentialStore();
    await store.set(SERVER, 'token-a');
    await store.set('https://other.internal', 'token-b');

    await store.clear(SERVER);

    expect(await store.get(SERVER)).toBeNull();
    expect(await store.get('https://other.internal')).toBe('token-b');
  });

  it('survives a corrupt credential file instead of failing every command', async () => {
    const store = new CredentialStore();
    await store.set(SERVER, 'token-1');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath(), '{ this is not json');

    expect(await new CredentialStore().get(SERVER)).toBeNull();
    // And it recovers: the next write replaces the unreadable file.
    await new CredentialStore().set(SERVER, 'token-2');
    expect(await new CredentialStore().get(SERVER)).toBe('token-2');
  });

  it('says plainly when the token is on disk rather than in a keychain', async () => {
    process.env.SAGA_TOKEN = 'ci-token';
    const status = await new CredentialStore().status();

    expect(status.backend).toBe('file');
    expect(status.detail).toContain('0600');
    expect(status.detail).toContain('credentials.json');
  });

  it('never writes the token into the reported status detail', async () => {
    process.env.SAGA_TOKEN = 'super-secret-token';
    const status = await new CredentialStore().status();
    expect(status.detail).not.toContain('super-secret-token');
  });

  it('does not leave the raw token in the file under any other key', async () => {
    await new CredentialStore().set(SERVER, 'token-1');
    const parsed = JSON.parse(readFileSync(filePath(), 'utf8')) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual([SERVER]);
  });
});
