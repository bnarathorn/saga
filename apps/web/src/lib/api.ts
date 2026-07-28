import type { ErrorEnvelopeDto } from '@saga/contracts';

/**
 * A failed API call, carrying Saga's stable error code so the UI can react to specific
 * conditions (a 409 conflict, a missing scope) rather than parsing messages.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  idempotencyKey?: string;
}

/**
 * The single place Guild Hall talks to the API. It attaches the CSRF header for every
 * mutation so no individual screen can forget to.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie('saga_csrf');
    if (csrf !== null) headers['x-saga-csrf'] = csrf;
  }
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const payload: unknown = text.length === 0 ? null : safeJsonParse(text);

  if (!response.ok) {
    const envelope = payload as ErrorEnvelopeDto | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? 'INTERNAL_ERROR',
      envelope?.error?.message ?? `Request failed with status ${response.status}.`,
      envelope?.error?.details ?? {},
      envelope?.error?.request_id ?? response.headers.get('x-request-id'),
    );
  }

  return payload as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    apiRequest<T>(path, { method: 'POST', body: body ?? {}, idempotencyKey }),
  patch: <T>(path: string, body: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};

/** Generate a client-side idempotency key for a create action the user might double-click. */
export function newIdempotencyKey(): string {
  return `gh-${crypto.randomUUID()}`;
}
