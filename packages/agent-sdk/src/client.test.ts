import { isSagaError } from '@saga/shared';
import { describe, expect, it, vi } from 'vitest';
import { RETRY_GUIDANCE, SagaClient } from './client.js';

/**
 * The SDK's contract with an integration (spec 14).
 *
 * The load-bearing property is the one in the class comment: a conflict is never retried.
 * Retrying a `QUEST_REVISION_CONFLICT` would overwrite whatever the other session wrote, and
 * until this suite existed that promise was asserted only by a comment.
 */

function errorBody(code: string, message = 'nope') {
  return JSON.stringify({ error: { code, message, details: {}, request_id: 'req_1' } });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new SagaClient({
    baseUrl: 'http://saga.test/',
    token: 'agent-token',
    fetch: fetchImpl,
    maxRetries: 3,
    ...overrides,
  });
}

describe('SagaClient request handling', () => {
  it('sends the bearer token, the client name and the idempotency key', async () => {
    const calls: RequestInit[] = [];
    const doFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init!);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await client(doFetch, { client: 'my-agent' }).request(
      'POST',
      '/api/x',
      { a: 1 },
      {
        idempotencyKey: 'key-1',
      },
    );

    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer agent-token');
    expect(headers['x-saga-client']).toBe('my-agent');
    expect(headers['idempotency-key']).toBe('key-1');
    expect(headers['content-type']).toBe('application/json');
  });

  it('omits the content-type header when there is no body', async () => {
    const calls: RequestInit[] = [];
    const doFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init!);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await client(doFetch).whoami();
    expect((calls[0]!.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('strips a trailing slash from the base URL rather than producing a double slash', async () => {
    const urls: string[] = [];
    const doFetch = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await client(doFetch).whoami();
    expect(urls[0]).toBe('http://saga.test/api/auth/me');
  });
});

describe('SagaClient retry policy', () => {
  const CONFLICTS = [
    'QUEST_REVISION_CONFLICT',
    'MEMORY_UPDATE_CONFLICT',
    'RESOURCE_CLAIM_CONFLICT',
    'IDEMPOTENCY_KEY_REUSED',
    'MEMORY_SECRET_DETECTED',
    'COORDINATION_UNAVAILABLE',
  ] as const;

  for (const code of CONFLICTS) {
    it(`never retries ${code}, even when the server answers 500`, async () => {
      // A 500 would normally be retried; the code has to win over the status.
      const doFetch = vi.fn(
        async () => new Response(errorBody(code), { status: 500 }),
      ) as unknown as typeof fetch;

      await expect(client(doFetch).request('POST', '/api/x', {})).rejects.toMatchObject({ code });
      expect(doFetch).toHaveBeenCalledTimes(1);
    });
  }

  it('never retries an authorization failure', async () => {
    const doFetch = vi.fn(
      async () => new Response(errorBody('SCOPE_REQUIRED'), { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(client(doFetch).whoami()).rejects.toMatchObject({ code: 'SCOPE_REQUIRED' });
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry any 4xx: the same request would fail the same way', async () => {
    const doFetch = vi.fn(
      async () => new Response(errorBody('QUEST_NOT_FOUND'), { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(client(doFetch).quest('q1')).rejects.toMatchObject({ code: 'QUEST_NOT_FOUND' });
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 503 and returns the eventual success', async () => {
    let attempt = 0;
    const doFetch = vi.fn(async () => {
      attempt += 1;
      if (attempt < 3) return new Response(errorBody('SERVICE_UNAVAILABLE'), { status: 503 });
      return jsonResponse({ status: 'healthy', version: '0.1.0' });
    }) as unknown as typeof fetch;

    const result = await client(doFetch).health();

    expect(result.version).toBe('0.1.0');
    expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it('retries a network failure and gives up with the last error', async () => {
    const doFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(client(doFetch, { maxRetries: 2 }).whoami()).rejects.toThrow('ECONNREFUSED');
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it('reports each retry so a CLI can show progress', async () => {
    const retries: number[] = [];
    let attempt = 0;
    const doFetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return new Response(errorBody('SERVICE_UNAVAILABLE'), { status: 503 });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await client(doFetch, { onRetry: (n: number) => retries.push(n) }).whoami();
    expect(retries).toEqual([1]);
  });

  it('marks a 5xx retryable and a conflict not retryable on the error itself', async () => {
    const transient = vi.fn(
      async () => new Response(errorBody('SERVICE_UNAVAILABLE'), { status: 503 }),
    ) as unknown as typeof fetch;
    const conflict = vi.fn(
      async () => new Response(errorBody('QUEST_REVISION_CONFLICT'), { status: 409 }),
    ) as unknown as typeof fetch;

    const transientError = await client(transient, { maxRetries: 1 })
      .whoami()
      .catch((e) => e);
    const conflictError = await client(conflict)
      .whoami()
      .catch((e) => e);

    expect(isSagaError(transientError) && transientError.retryable).toBe(true);
    expect(isSagaError(conflictError) && conflictError.retryable).toBe(false);
  });

  it('surfaces the server error code and message rather than the HTTP status alone', async () => {
    const doFetch = vi.fn(
      async () =>
        new Response(errorBody('MEMORY_SECRET_DETECTED', 'body contains a password'), {
          status: 422,
        }),
    ) as unknown as typeof fetch;

    await expect(
      client(doFetch).remember('p1', { summary: 's', entries: [] } as never),
    ).rejects.toMatchObject({
      code: 'MEMORY_SECRET_DETECTED',
      message: 'body contains a password',
    });
  });

  it('falls back to a stable error when the body is not an error envelope', async () => {
    const doFetch = vi.fn(
      async () => new Response('<html>gateway</html>', { status: 502 }),
    ) as unknown as typeof fetch;

    await expect(client(doFetch, { maxRetries: 1 }).whoami()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('honours a signal that was already aborted before the call', async () => {
    const controller = new AbortController();
    controller.abort();

    // An already-aborted signal never fires its event, so the client has to check it. A fetch
    // that ignored it would send the request the caller has already cancelled.
    const doFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted === true) throw new Error('aborted');
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await expect(
      client(doFetch, { maxRetries: 1 }).request('GET', '/api/x', undefined, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
  });

  it('aborts an in-flight request when the caller signals', async () => {
    const controller = new AbortController();
    const doFetch = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          setTimeout(() => controller.abort(), 5);
        }),
    ) as unknown as typeof fetch;

    await expect(
      client(doFetch, { maxRetries: 1 }).request('GET', '/api/x', undefined, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
  });
});

describe('conflict guidance', () => {
  it('documents recovery for every conflict an integration must handle itself', () => {
    for (const code of [
      'QUEST_REVISION_CONFLICT',
      'MEMORY_UPDATE_CONFLICT',
      'RESOURCE_CLAIM_CONFLICT',
      'COORDINATION_UNAVAILABLE',
      'MEMORY_SECRET_DETECTED',
      'IDEMPOTENCY_KEY_REUSED',
    ] as const) {
      expect(RETRY_GUIDANCE[code]).toBeTruthy();
      // Guidance that says "retry" would contradict the policy it exists to explain.
      expect(RETRY_GUIDANCE[code]).not.toMatch(/^retry/i);
    }
  });
});

describe('SagaClient endpoints', () => {
  it('encodes a project reference that contains a space', async () => {
    const urls: string[] = [];
    const doFetch = vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return jsonResponse({ items: [] });
    }) as unknown as typeof fetch;

    await client(doFetch).quests('ERP Backoffice', '?limit=10');
    expect(urls[0]).toBe('http://saga.test/api/projects/ERP%20Backoffice/quests?limit=10');
  });

  it('releases a claim on behalf of the run that holds it', async () => {
    const bodies: unknown[] = [];
    const doFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return jsonResponse({ claim: {} });
    }) as unknown as typeof fetch;

    await client(doFetch).releaseClaim('claim-1', 'run-1', 'done');
    expect(bodies[0]).toEqual({ agent_run_id: 'run-1', reason: 'done' });
  });

  it('renews claims alongside the run lease by default', async () => {
    const bodies: unknown[] = [];
    const doFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return jsonResponse({ agent_run: {}, renewed_claims: 2, overlaps: [] });
    }) as unknown as typeof fetch;

    await client(doFetch).partyHeartbeat('run-1');
    expect(bodies[0]).toEqual({ renew_claims: true });
  });
});
