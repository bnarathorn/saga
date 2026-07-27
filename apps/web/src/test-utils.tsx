import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';

export function renderWithProviders(
  ui: ReactElement,
  options: { route?: string; path?: string } = {},
): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  // When `path` is given the component is mounted under a matching route, so components that
  // read `useParams()` receive real values instead of undefined.
  const tree =
    options.path === undefined ? (
      ui
    ) : (
      <Routes>
        <Route path={options.path} element={ui} />
      </Routes>
    );

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.route ?? '/']}>{tree}</MemoryRouter>
    </QueryClientProvider>,
  );

  return { ...result, queryClient };
}

export interface StubRoute {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Stub `fetch` with a path -> response map. Any unmatched path fails loudly rather than
 * silently returning undefined, so a test cannot pass because a request was never made.
 */
export function stubFetch(routes: Record<string, StubRoute | (() => StubRoute)>): {
  calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[];
} {
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const key = `${method} ${url}`;
      calls.push({
        method,
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });

      const entry = routes[key] ?? routes[url];
      if (entry === undefined) {
        throw new Error(`Unstubbed request: ${key}. Stubbed: ${Object.keys(routes).join(', ')}`);
      }
      const stub = typeof entry === 'function' ? entry() : entry;
      return new Response(JSON.stringify(stub.body), {
        status: stub.status ?? 200,
        headers: { 'content-type': 'application/json', ...stub.headers },
      });
    }),
  );

  return { calls };
}

export const adminMe = {
  authenticated: true,
  actor_type: 'user' as const,
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'admin@saga.test',
    display_name: 'Administrator',
    role: 'admin' as const,
    last_login_at: null,
  },
  agent: null,
  csrf_token: 'test-csrf-token',
};

export function projectSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    name: 'ERP Backoffice',
    name_key: 'erp backoffice',
    description: null,
    status: 'active',
    memory_revision: 3,
    active_context_snapshot_id: '00000000-0000-4000-8000-000000000020',
    lore_approval_mode: 'auto',
    aliases: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stats: {
      lore_entry_count: 12,
      stale_lore_count: 0,
      open_quest_count: 2,
      blocked_quest_count: 0,
      active_agent_count: 1,
      failed_job_count: 0,
      last_activity_at: new Date().toISOString(),
    },
    bootstrap_required: false,
    ...overrides,
  };
}
