import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, type ApiHarness } from '../testing/api-harness.js';

/**
 * `GET /api/cli/saga` is how a client machine obtains the CLI at all: no repository, no registry,
 * no credential. That makes two properties load-bearing — it must answer without authentication,
 * and it must say what to do when this server has no build to hand out.
 */

/** A pack directory shaped like the one `pnpm --filter @saga/cli bundle` leaves behind. */
function fakePack(options: { artifact?: string; version?: string | null }): string {
  const packDir = mkdtempSync(join(tmpdir(), 'saga-cli-pack-'));
  const distDir = join(packDir, 'dist');
  mkdirSync(distDir);
  if (options.artifact !== undefined) writeFileSync(join(distDir, 'saga'), options.artifact);
  if (options.version !== null) {
    writeFileSync(
      join(packDir, 'package.json'),
      JSON.stringify({ name: 'saga-cli', version: options.version ?? '9.9.9' }),
    );
  }
  return distDir;
}

describe('GET /api/cli/saga', () => {
  const ARTIFACT = '#!/usr/bin/env node\nconsole.log("saga");\n';
  let built: ApiHarness;
  let unbuilt: ApiHarness;

  beforeAll(async () => {
    built = await createApiHarness({
      config: { SAGA_CLI_ARTIFACT_DIR: fakePack({ artifact: ARTIFACT, version: '9.9.9' }) },
    });
    unbuilt = await createApiHarness({
      config: { SAGA_CLI_ARTIFACT_DIR: fakePack({ version: null }) },
    });
  });

  afterAll(async () => {
    await built.close();
    await unbuilt.close();
  });

  it('serves the executable to a caller with no credentials at all', async () => {
    const response = await built.anonymous().get('/api/cli/saga');

    expect(response.status).toBe(200);
    expect(response.body).toBe(ARTIFACT);
    expect(response.headers['content-disposition']).toBe('attachment; filename="saga"');
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(ARTIFACT)));
  });

  it('reports the version of the artifact, which is not the server version', async () => {
    const response = await built.anonymous().get('/api/cli/saga');

    // The manifest beside the artifact says 9.9.9; the server is 0.1.0. Reading the wrong one is
    // exactly the mistake that makes a stale download look current.
    expect(response.headers['x-saga-cli-version']).toBe('9.9.9');
    expect(built.config.version).not.toBe('9.9.9');
  });

  it('answers 304 to a client that already has this build', async () => {
    const first = await built.anonymous().get('/api/cli/saga');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);

    const second = await built.anonymous().get('/api/cli/saga', { 'if-none-match': etag });
    expect(second.status).toBe(304);
    expect(second.body).toBeNull();
  });

  it('says how to produce the build when the server has none', async () => {
    const response = await unbuilt.anonymous().get('/api/cli/saga');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toMatch(/pnpm --filter @saga\/cli bundle/);
  });
});
