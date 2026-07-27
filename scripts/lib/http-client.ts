/**
 * Tiny HTTP client used by the demo and verification scripts. It keeps the session cookie and
 * CSRF token so the scripts drive Saga exactly the way Guild Hall does.
 */
export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

export class ScriptClient {
  private cookies = new Map<string, string>();
  private csrfToken: string | null = null;
  private agentToken: string | null = null;

  constructor(readonly baseUrl: string) {}

  useAgentToken(token: string | null): void {
    this.agentToken = token;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.agentToken !== null) headers.authorization = `Bearer ${this.agentToken}`;
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    if (this.csrfToken !== null && !['GET', 'HEAD'].includes(method)) {
      headers['x-saga-csrf'] = this.csrfToken;
    }

    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (pair !== undefined && index > 0) {
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        if (value.length === 0) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
    if (this.cookies.has('saga_csrf')) this.csrfToken = this.cookies.get('saga_csrf') ?? null;

    const text = await response.text();
    const parsed = text.length === 0 ? null : (JSON.parse(text) as T);
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path);
  }

  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('POST', path, body ?? {}, headers);
  }

  patch<T = unknown>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }

  async login(email: string, password: string): Promise<void> {
    const result = await this.request('POST', '/api/auth/login', { email, password });
    if (result.status !== 200) {
      throw new Error(`login failed (${result.status}): ${JSON.stringify(result.body)}`);
    }
  }

  async waitFor<T>(
    describe: string,
    probe: () => Promise<T | null>,
    timeoutMs = 30_000,
    intervalMs = 400,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | null = null;
    while (Date.now() < deadline) {
      last = await probe();
      if (last !== null) return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${describe}`);
  }
}

let failures = 0;
let checks = 0;

export function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  ✗ ${label}\n`);
    if (detail !== undefined) {
      process.stdout.write(`      ${JSON.stringify(detail).slice(0, 400)}\n`);
    }
  }
}

export function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

export function summarize(): number {
  process.stdout.write(
    `\n${checks - failures}/${checks} checks passed${failures === 0 ? '' : ` — ${failures} FAILED`}\n`,
  );
  return failures === 0 ? 0 : 1;
}
