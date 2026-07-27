import type { FastifyInstance, InjectOptions } from 'fastify';
import type { SagaPool } from '@saga/database';
import type { SagaConfig } from '@saga/shared/config';
import { createTestPool, createTestServices, testConfig, truncateAll } from '../../../../testing/harness.js';
import { buildApp, type BuildAppOptions } from '../app.js';
import { buildContext, type AppContext } from '../composition.js';

export interface ApiHarness {
  app: FastifyInstance;
  ctx: AppContext;
  pool: SagaPool;
  config: SagaConfig;
  reset(): Promise<void>;
  close(): Promise<void>;
  /** Authenticate as a user and return a client that carries the session and CSRF token. */
  loginAs(role: 'admin' | 'operator' | 'viewer', email?: string): Promise<ApiClient>;
  anonymous(): ApiClient;
  withAgentToken(token: string): ApiClient;
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

export class ApiClient {
  private cookies = new Map<string, string>();
  private csrfToken: string | null = null;

  constructor(
    private readonly app: FastifyInstance,
    private readonly bearer: string | null = null,
  ) {}

  async request<T = any>(
    method: InjectOptions['method'],
    url: string,
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.bearer !== null) headers.authorization = `Bearer ${this.bearer}`;
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    if (this.csrfToken !== null && method !== 'GET' && headers['x-saga-csrf'] === undefined) {
      headers['x-saga-csrf'] = this.csrfToken;
    }

    const response = await this.app.inject({ method, url, payload: payload as never, headers });

    for (const raw of response.cookies) {
      if (raw.value.length === 0) this.cookies.delete(raw.name);
      else this.cookies.set(raw.name, raw.value);
      if (raw.name === 'saga_csrf') this.csrfToken = raw.value.length === 0 ? null : raw.value;
    }

    let body: T;
    try {
      body = response.body.length === 0 ? (null as T) : (JSON.parse(response.body) as T);
    } catch {
      body = response.body as unknown as T;
    }
    return { status: response.statusCode, body, headers: response.headers };
  }

  get<T = any>(url: string, headers?: Record<string, string>) {
    return this.request<T>('GET', url, undefined, headers);
  }
  post<T = any>(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.request<T>('POST', url, payload ?? {}, headers);
  }
  patch<T = any>(url: string, payload: unknown, headers?: Record<string, string>) {
    return this.request<T>('PATCH', url, payload, headers);
  }
  del<T = any>(url: string, headers?: Record<string, string>) {
    return this.request<T>('DELETE', url, undefined, headers);
  }

  /** Deliberately omit the CSRF header, to prove the double-submit check bites. */
  postWithoutCsrf<T = any>(url: string, payload?: unknown) {
    const saved = this.csrfToken;
    this.csrfToken = null;
    return this.request<T>('POST', url, payload ?? {}).finally(() => {
      this.csrfToken = saved;
    });
  }
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export async function createApiHarness(
  options: { config?: Partial<NodeJS.ProcessEnv>; appOptions?: Partial<BuildAppOptions> } = {},
): Promise<ApiHarness> {
  const config = testConfig(options.config);
  const pool = createTestPool('saga-api-test');
  const ctx = buildContext({ config, pool, role: 'test' });
  const app = await buildApp({ ctx, ...options.appOptions });

  const harness: ApiHarness = {
    app,
    ctx,
    pool,
    config,
    async reset() {
      await truncateAll(pool);
    },
    async close() {
      await app.close();
      await pool.end();
    },
    anonymous: () => new ApiClient(app),
    withAgentToken: (token: string) => new ApiClient(app, token),
    async loginAs(role, email = `${role}@saga.test`) {
      const services = createTestServices({ pool, config });
      const existing = await services.repositories.users.findByEmail(pool, email);
      if (existing === null) {
        await services.auth.createUser({
          email,
          displayName: `${role} user`,
          password: TEST_PASSWORD,
          role,
        });
      }
      const client = new ApiClient(app);
      const response = await client.post('/api/auth/login', { email, password: TEST_PASSWORD });
      if (response.status !== 200) {
        throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return client;
    },
  };

  return harness;
}
