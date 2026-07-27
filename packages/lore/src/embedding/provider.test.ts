import { SagaError } from '@saga/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeterministicFakeEmbeddingProvider,
  OllamaEmbeddingProvider,
  assertSchemaDimensions,
  createEmbeddingProvider,
  l2Normalize,
} from './provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deterministic fake provider', () => {
  const provider = new DeterministicFakeEmbeddingProvider(768);

  it('produces vectors of the configured dimension', async () => {
    const [vector] = await provider.embed(['hello']);
    expect(vector).toHaveLength(768);
  });

  it('is deterministic across calls and across instances', async () => {
    const [first] = await provider.embed(['run.api.local']);
    const [second] = await new DeterministicFakeEmbeddingProvider(768).embed(['run.api.local']);
    expect(first).toEqual(second);
  });

  it('produces different vectors for different inputs', async () => {
    const [a, b] = await provider.embed(['alpha', 'beta']);
    expect(a).not.toEqual(b);
  });

  it('returns unit vectors so cosine distance behaves', async () => {
    const [vector] = await provider.embed(['normalise me']);
    const norm = Math.sqrt(vector!.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it('embeds a batch in order', async () => {
    const batch = await provider.embed(['one', 'two', 'three']);
    expect(batch).toHaveLength(3);
    const [single] = await provider.embed(['two']);
    expect(batch[1]).toEqual(single);
  });

  it('handles an empty string and an empty batch', async () => {
    expect(await provider.embed([])).toEqual([]);
    const [vector] = await provider.embed(['']);
    expect(vector).toHaveLength(768);
  });

  it('supports a non-default dimension', async () => {
    const [vector] = await new DeterministicFakeEmbeddingProvider(16).embed(['x']);
    expect(vector).toHaveLength(16);
  });

  it('rejects a nonsensical dimension', () => {
    expect(() => new DeterministicFakeEmbeddingProvider(0)).toThrow(SagaError);
    expect(() => new DeterministicFakeEmbeddingProvider(1.5)).toThrow(SagaError);
  });

  it('reports itself healthy without any network call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('the fake provider must not use the network');
      }),
    );
    expect((await provider.healthCheck()).status).toBe('healthy');
  });
});

describe('l2Normalize', () => {
  it('leaves a zero vector alone rather than producing NaN', () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('scales to unit length', () => {
    expect(l2Normalize([3, 4])).toEqual([0.6, 0.8]);
  });
});

describe('ollama provider', () => {
  const provider = new OllamaEmbeddingProvider({
    baseUrl: 'http://ollama.test',
    model: 'nomic-embed-text',
    dimensions: 4,
    timeoutMs: 1_000,
  });

  it('normalises the vectors it receives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ embeddings: [[3, 4, 0, 0]] }), { status: 200 })),
    );
    const [vector] = await provider.embed(['x']);
    expect(vector).toEqual([0.6, 0.8, 0, 0]);
  });

  it('treats an unreachable provider as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(provider.embed(['x'])).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('treats a non-2xx response as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    await expect(provider.embed(['x'])).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('treats a dimension mismatch as permanent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), { status: 200 })),
    );
    await expect(provider.embed(['x'])).rejects.toMatchObject({
      code: 'EMBEDDING_DIMENSION_MISMATCH',
      retryable: false,
    });
  });

  it('rejects a response with the wrong number of vectors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ embeddings: [[1, 0, 0, 0]] }), { status: 200 })),
    );
    await expect(provider.embed(['a', 'b'])).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
    });
  });

  it('reports degraded when the model is not pulled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200 })),
    );
    const health = await provider.healthCheck();
    expect(health.status).toBe('degraded');
    expect(health.message).toContain('ollama pull');
  });

  it('reports healthy when the model is present, tag suffix and all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }), {
            status: 200,
          }),
      ),
    );
    expect((await provider.healthCheck()).status).toBe('healthy');
  });

  it('reports unhealthy rather than throwing when the host is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ENOTFOUND');
      }),
    );
    const health = await provider.healthCheck();
    expect(health.status).toBe('unhealthy');
  });
});

describe('provider selection', () => {
  it('builds the configured provider', () => {
    const fake = createEmbeddingProvider({
      provider: 'fake',
      dimensions: 768,
      model: 'x',
      ollamaUrl: 'http://localhost:11434',
      timeoutMs: 1_000,
    });
    expect(fake.name).toBe('fake');

    const ollama = createEmbeddingProvider({
      provider: 'ollama',
      dimensions: 768,
      model: 'nomic-embed-text',
      ollamaUrl: 'http://localhost:11434',
      timeoutMs: 1_000,
    });
    expect(ollama.name).toBe('ollama');
  });

  it('refuses a provider whose dimension does not match the schema', () => {
    expect(() => assertSchemaDimensions(new DeterministicFakeEmbeddingProvider(1_024))).toThrow(
      /768/,
    );
    expect(() => assertSchemaDimensions(new DeterministicFakeEmbeddingProvider(768))).not.toThrow();
  });
});
