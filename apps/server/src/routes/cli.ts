import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SagaError } from '@saga/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../composition.js';

/**
 * `GET /api/cli/saga` — hand out the `saga` command itself.
 *
 * A client needs the CLI before it has a token, so this route is deliberately public: it never
 * calls `request.requirePermission`, which is what makes a route public here (see
 * `plugins/auth.ts`, where the global hook resolves an actor but rejects nobody). What it serves
 * is a single self-contained executable built by `pnpm --filter @saga/cli bundle` — no registry,
 * no package manager, no clone of this repository:
 *
 *   curl -fsSL https://<server>/api/cli/saga -o ~/.local/bin/saga && chmod +x ~/.local/bin/saga
 *
 * Serving it from the API rather than from a file someone copied by hand is what keeps versions
 * honest: the CLI a client downloads is the one this server was built with, so the compatibility
 * check in the CLI has nothing to catch.
 *
 * The path deliberately sits under `/api/` because that is already proxied everywhere — Compose
 * publishes only the Guild Hall container, and the API has no host port of its own.
 */
export function registerCliRoutes(app: FastifyInstance, ctx: AppContext): void {
  const artifactDir = resolveCliArtifactDir(ctx.config.cli.artifactDir);
  const artifactPath = join(artifactDir, 'saga');

  app.get('/api/cli/saga', async (request, reply) => {
    const stats = await stat(artifactPath).catch(() => null);
    if (stats === null || !stats.isFile()) {
      throw new SagaError(
        'NOT_FOUND',
        'This server has no CLI build to hand out. It is produced by ' +
          '`pnpm --filter @saga/cli bundle`, which the container image runs at build time; a ' +
          'server started straight from a working tree needs it run once by hand.',
      );
    }

    // The artifact changes only when the server is rebuilt, so a validator costs one stat and
    // saves re-sending 760 KB to every agent host that already has it.
    const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    if (request.headers['if-none-match'] === etag) {
      return reply.status(304).send();
    }

    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', 'attachment; filename="saga"')
      .header('content-length', stats.size)
      .header('etag', etag)
      .header('x-saga-cli-version', await readArtifactVersion(artifactDir))
      .send(createReadStream(artifactPath));
  });
}

/**
 * Where `bundle.mjs` writes. `apps/server/{src,dist}/routes/` sit at the same depth, so one
 * relative path is correct whether this is running as TypeScript under vitest or as compiled
 * JavaScript in the image.
 */
export function resolveCliArtifactDir(configured: string | null): string {
  if (configured !== null) return resolve(configured);
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../cli/pack/dist');
}

/**
 * The version of the artifact, which is not `config.version`: that is the server's, and the two
 * are only equal when both came from the same build. Read from the manifest `bundle.mjs` writes
 * beside `dist/`, and cached, because a client that fetches the CLI fetches it once.
 */
let cachedVersion: { dir: string; version: string } | null = null;

async function readArtifactVersion(artifactDir: string): Promise<string> {
  if (cachedVersion?.dir === artifactDir) return cachedVersion.version;

  const manifestPath = join(dirname(artifactDir), 'package.json');
  const version = await readFile(manifestPath, 'utf8').then(
    (raw) => {
      const parsed: unknown = JSON.parse(raw);
      const value =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { version?: unknown }).version
          : undefined;
      return typeof value === 'string' ? value : 'unknown';
    },
    () => 'unknown',
  );

  cachedVersion = { dir: artifactDir, version };
  return version;
}
