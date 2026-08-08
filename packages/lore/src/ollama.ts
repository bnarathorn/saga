/**
 * The parts of talking to Ollama that both providers need.
 *
 * Two of them exist — `OllamaEmbeddingProvider` for vectors and `OllamaRelationProposer` for
 * relation inference — against the same server at the same `SAGA_OLLAMA_URL`. They ask
 * different endpoints for different things, but reaching the server, bounding the request and
 * answering "is that model actually pulled?" are identical, and were written twice.
 */

export interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  detail?: Record<string, unknown>;
}

/** A trailing slash would produce `//api/tags`, which Ollama does not route. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

/**
 * `fetch` that gives up rather than hanging.
 *
 * A model server that accepts the connection and then stalls would otherwise hold a worker's
 * job slot until the process restarts; the caller's timeout is what bounds that.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the server up, and is this model pulled?
 *
 * The distinction is the point. Unreachable is `unhealthy` and means check the URL or the
 * service; reachable-but-not-pulled is `degraded` and has exactly one remedy, which the
 * message names. Getting a plain "provider unavailable" for a model somebody forgot to pull
 * sends operators looking in the wrong place.
 */
export async function probeOllamaModel(options: {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Merged into every returned `detail`, for whatever the caller wants to add. */
  detail?: Record<string, unknown>;
}): Promise<ProviderHealth> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const detail = { base_url: baseUrl, model: options.model, ...options.detail };

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/api/tags`,
      { method: 'GET' },
      options.timeoutMs,
    );
    if (!response.ok) {
      return {
        status: 'unhealthy',
        message: `Ollama answered ${response.status}.`,
        detail,
      };
    }

    const body = (await response.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((entry) => entry.name ?? '');
    // `ollama pull qwen2.5:7b` registers `qwen2.5:7b`, while a bare `qwen2.5` registers
    // `qwen2.5:latest` — so an exact match or a tagged form of the same name both count.
    const present = names.some(
      (name) => name === options.model || name.startsWith(`${options.model}:`),
    );
    if (!present) {
      return {
        status: 'degraded',
        message: `Ollama is reachable but the model "${options.model}" is not pulled. Run: ollama pull ${options.model}`,
        detail,
      };
    }

    return {
      status: 'healthy',
      message: `Ollama is serving "${options.model}".`,
      detail,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      message: `Ollama is unreachable at ${baseUrl}.`,
      detail: { ...detail, reason: error instanceof Error ? error.message : 'unknown' },
    };
  }
}
