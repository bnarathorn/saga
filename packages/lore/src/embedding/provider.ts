import { createHash } from 'node:crypto';
import { SagaError } from '@saga/shared';

export interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  detail?: Record<string, unknown>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  healthCheck(): Promise<ProviderHealth>;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic fake provider (ADR-0006).
 *
 * SHA-256 in counter mode expanded to the configured dimension, then L2-normalised. It is
 * identical across processes, machines and runs for the same input, which is what makes
 * vector-search assertions reproducible without a model server.
 */
export class DeterministicFakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';

  constructor(readonly dimensions: number = 768) {
    if (dimensions <= 0 || !Number.isInteger(dimensions)) {
      throw new SagaError('INTERNAL_ERROR', 'Embedding dimensions must be a positive integer.');
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: 'healthy',
      message: 'Deterministic fake embeddings (no external provider).',
      detail: { dimensions: this.dimensions },
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const seed = createHash('sha256').update(text, 'utf8').digest();
    const values = new Array<number>(this.dimensions);

    let produced = 0;
    let counter = 0;
    while (produced < this.dimensions) {
      const block = createHash('sha256')
        .update(seed)
        .update(Buffer.from([counter & 0xff, (counter >> 8) & 0xff]))
        .digest();
      for (let offset = 0; offset + 2 <= block.length && produced < this.dimensions; offset += 2) {
        // Map a 16-bit window to [-1, 1).
        const raw = block.readUInt16BE(offset);
        values[produced] = raw / 32_768 - 1;
        produced += 1;
      }
      counter += 1;
    }

    return l2Normalize(values);
  }
}

export function l2Normalize(values: number[]): number[] {
  let sumSquares = 0;
  for (const value of values) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  // A zero vector cannot be normalised; return it unchanged rather than producing NaNs.
  if (norm === 0) return values;
  return values.map((value) => value / norm);
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs?: number;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
  error?: string;
}

/**
 * Ollama adapter. Failures are surfaced as retryable `EMBEDDING_PROVIDER_UNAVAILABLE`; a
 * dimension mismatch is a permanent `EMBEDDING_DIMENSION_MISMATCH` because retrying cannot
 * change the model's output size.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly dimensions: number;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/api/tags`, { method: 'GET' });
      if (!response.ok) {
        return {
          status: 'unhealthy',
          message: `Ollama answered ${response.status}.`,
          detail: { base_url: this.baseUrl },
        };
      }
      const body = (await response.json()) as { models?: { name?: string }[] };
      const names = (body.models ?? []).map((entry) => entry.name ?? '');
      const present = names.some((name) => name === this.model || name.startsWith(`${this.model}:`));
      if (!present) {
        return {
          status: 'degraded',
          message: `Ollama is reachable but the model "${this.model}" is not pulled. Run: ollama pull ${this.model}`,
          detail: { base_url: this.baseUrl, model: this.model },
        };
      }
      return {
        status: 'healthy',
        message: `Ollama is serving "${this.model}".`,
        detail: { base_url: this.baseUrl, model: this.model, dimensions: this.dimensions },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: `Ollama is unreachable at ${this.baseUrl}.`,
        detail: { reason: error instanceof Error ? error.message : 'unknown' },
      };
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (error) {
      throw new SagaError(
        'EMBEDDING_PROVIDER_UNAVAILABLE',
        `Could not reach the embedding provider at ${this.baseUrl}.`,
        { cause: error, retryable: true },
      );
    }

    if (!response.ok) {
      throw new SagaError(
        'EMBEDDING_PROVIDER_UNAVAILABLE',
        `The embedding provider answered ${response.status}.`,
        { retryable: true, details: { status: response.status } },
      );
    }

    const body = (await response.json()) as OllamaEmbedResponse;
    const vectors = body.embeddings ?? (body.embedding === undefined ? undefined : [body.embedding]);

    if (vectors === undefined || vectors.length !== texts.length) {
      throw new SagaError(
        'EMBEDDING_PROVIDER_UNAVAILABLE',
        'The embedding provider returned an unexpected number of vectors.',
        { retryable: true, details: { expected: texts.length, received: vectors?.length ?? 0 } },
      );
    }

    for (const vector of vectors) {
      if (vector.length !== this.dimensions) {
        // Permanent: the column is fixed at the configured dimension (ADR-0006).
        throw new SagaError(
          'EMBEDDING_DIMENSION_MISMATCH',
          `The model "${this.model}" produced ${vector.length}-dimensional vectors, but this Saga schema stores ${this.dimensions}. Add a migration and a new embedding profile rather than mixing dimensions.`,
          { retryable: false, details: { expected: this.dimensions, received: vector.length } },
        );
      }
    }

    return vectors.map((vector) => l2Normalize(vector));
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface EmbeddingProviderConfig {
  provider: 'fake' | 'ollama';
  dimensions: number;
  model: string;
  ollamaUrl: string;
  timeoutMs: number;
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  if (config.provider === 'ollama') {
    return new OllamaEmbeddingProvider({
      baseUrl: config.ollamaUrl,
      model: config.model,
      dimensions: config.dimensions,
      timeoutMs: config.timeoutMs,
    });
  }
  return new DeterministicFakeEmbeddingProvider(config.dimensions);
}

/** The dimension the current schema stores. Changing it requires a migration. */
export const SCHEMA_EMBEDDING_DIMENSIONS = 768;

export function assertSchemaDimensions(provider: EmbeddingProvider): void {
  if (provider.dimensions !== SCHEMA_EMBEDDING_DIMENSIONS) {
    throw new SagaError(
      'EMBEDDING_DIMENSION_MISMATCH',
      `The embedding provider is configured for ${provider.dimensions} dimensions but this Saga schema stores ${SCHEMA_EMBEDDING_DIMENSIONS}.`,
      { retryable: false },
    );
  }
}
