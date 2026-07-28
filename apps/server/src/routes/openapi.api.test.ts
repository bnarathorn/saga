import { buildOpenApiDocument } from '@saga/contracts/openapi';
import { describe, expect, it } from 'vitest';
import { createApiHarness, type ApiHarness } from '../testing/api-harness.js';

/**
 * Spec 22.3: generated artifacts must not drift from the contracts they come from.
 *
 * `pnpm openapi:check` only diffs the generator against the committed JSON, so a route that
 * reaches the server without ever being registered in `packages/contracts/src/openapi.ts` was
 * invisible to it — 18 had accumulated that way, including one the specification names outright
 * (`GET /api/lore/updates/{updateId}`, spec 12.3). This compares the document against the live
 * Fastify route table instead, which is the only thing that knows what the server truly serves.
 */

/** Routes deliberately outside the documented API surface, with the reason. */
const NOT_IN_OPENAPI = new Set([
  // Orchestrator probes, not application resources.
  'GET /health/live',
  'GET /health/ready',
  // The service banner.
  'GET /api',
  // Long-lived text/event-stream; OpenAPI cannot usefully describe the frame protocol.
  'GET /api/events/stream',
  // Bounded fixture endpoint for proving the queue drains (documented in operations.md).
  'POST /api/shrine/jobs/probe',
]);

/**
 * `printRoutes` renders a tree: a child line carries only its own segment, so the full path is
 * the concatenation of the segments above it. Indentation is four columns per level.
 */
function flattenRoutes(printed: string): string[] {
  const operations: string[] = [];
  const prefixes: string[] = [];

  for (const line of printed.split('\n')) {
    if (line.trim().length === 0) continue;
    const marker = line.search(/[└├]/);
    const depth = marker < 0 ? 0 : Math.floor(marker / 4);
    const body = (marker < 0 ? line : line.slice(marker + 4)).trim();
    const parsed = /^(\S*)\s*(?:\((.+)\))?$/.exec(body);
    if (parsed === null) continue;

    prefixes.length = depth;
    prefixes[depth] = parsed[1] ?? '';
    if (parsed[2] === undefined) continue;

    const path = prefixes.slice(0, depth + 1).join('');
    for (const method of parsed[2].split(',').map((value) => value.trim())) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      operations.push(`${method} ${path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
    }
  }
  return operations;
}

function documentedOperations(): Set<string> {
  const document = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
  const operations = new Set<string>();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const method of Object.keys(methods)) operations.add(`${method.toUpperCase()} ${path}`);
  }
  return operations;
}

describe('the generated OpenAPI document', () => {
  let api: ApiHarness;

  it('documents every route the server actually serves', async () => {
    api = await createApiHarness();
    try {
      const served = flattenRoutes(
        api.app.printRoutes({ commonPrefix: false, includeHooks: false }),
      );
      // Guards the guard: a parser that silently returned nothing would pass vacuously.
      expect(served.length).toBeGreaterThan(60);
      expect(served).toContain('POST /api/sessions/{sessionId}/checkpoints');

      const documented = documentedOperations();
      const undocumented = served
        .filter((operation) => !NOT_IN_OPENAPI.has(operation))
        .filter((operation) => !documented.has(operation));

      expect([...new Set(undocumented)].sort()).toEqual([]);
    } finally {
      await api?.close();
    }
  });
});
