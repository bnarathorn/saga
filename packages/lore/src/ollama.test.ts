import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeBaseUrl, probeOllamaModel } from './ollama.js';

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => handler(String(input))),
  );
}

function tags(names: string[]): Response {
  return new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeBaseUrl', () => {
  it('drops a trailing slash so paths do not double up', () => {
    expect(normalizeBaseUrl('http://host:11434/')).toBe('http://host:11434');
    expect(normalizeBaseUrl('http://host:11434')).toBe('http://host:11434');
  });
});

describe('probeOllamaModel', () => {
  it('is healthy when the exact model is pulled', async () => {
    stubFetch(() => tags(['nomic-embed-text:latest', 'qwen2.5:7b-instruct']));
    const health = await probeOllamaModel({
      baseUrl: 'http://host:11434',
      model: 'qwen2.5:7b-instruct',
      timeoutMs: 100,
    });
    expect(health.status).toBe('healthy');
    expect(health.message).toContain('qwen2.5:7b-instruct');
  });

  it('accepts a tagged form of the same name', async () => {
    // `ollama pull qwen2.5` registers `qwen2.5:latest`, and asking for `qwen2.5` must match it.
    stubFetch(() => tags(['qwen2.5:latest']));
    const health = await probeOllamaModel({
      baseUrl: 'http://host:11434',
      model: 'qwen2.5',
      timeoutMs: 100,
    });
    expect(health.status).toBe('healthy');
  });

  it('degrades with the exact remedy when the model is not pulled', async () => {
    stubFetch(() => tags(['nomic-embed-text:latest']));
    const health = await probeOllamaModel({
      baseUrl: 'http://host:11434',
      model: 'qwen2.5:7b-instruct',
      timeoutMs: 100,
    });
    // Degraded, not unhealthy: the server is fine and there is one thing to do about it.
    expect(health.status).toBe('degraded');
    expect(health.message).toContain('ollama pull qwen2.5:7b-instruct');
  });

  it('is unhealthy when the server is unreachable', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const health = await probeOllamaModel({
      baseUrl: 'http://host:11434',
      model: 'qwen2.5',
      timeoutMs: 100,
    });
    expect(health.status).toBe('unhealthy');
    expect(health.message).toContain('unreachable');
    expect(health.detail).toMatchObject({ reason: 'ECONNREFUSED' });
  });

  it('is unhealthy when the server answers with an error status', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    const health = await probeOllamaModel({
      baseUrl: 'http://host:11434',
      model: 'qwen2.5',
      timeoutMs: 100,
    });
    expect(health.status).toBe('unhealthy');
    expect(health.message).toContain('500');
  });

  it('degrades rather than throwing when the model list is empty or missing', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    const health = await probeOllamaModel({
      baseUrl: 'http://host:11434',
      model: 'qwen2.5',
      timeoutMs: 100,
    });
    expect(health.status).toBe('degraded');
  });

  it('normalizes the base url before building the request', async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return tags(['qwen2.5:latest']);
    });
    await probeOllamaModel({
      baseUrl: 'http://host:11434/',
      model: 'qwen2.5',
      timeoutMs: 100,
    });
    expect(seen).toEqual(['http://host:11434/api/tags']);
  });

  it('carries the caller detail through every outcome', async () => {
    stubFetch(() => tags(['nomic-embed-text:latest']));
    const health = await probeOllamaModel({
      baseUrl: 'http://host:11434',
      model: 'nomic-embed-text',
      timeoutMs: 100,
      detail: { dimensions: 768 },
    });
    expect(health.detail).toMatchObject({
      base_url: 'http://host:11434',
      model: 'nomic-embed-text',
      dimensions: 768,
    });
  });
});
