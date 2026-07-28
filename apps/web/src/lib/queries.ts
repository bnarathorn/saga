import type {
  AuditLogDto,
  JobDto,
  MeResponse,
  MetricsSummaryDto,
  ProjectSummaryDto,
  SchemaVersionDto,
  ServiceInstanceDto,
  ShrineConfigDto,
  ShrineHealthDto,
  SystemEventDto,
} from '@saga/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api, newIdempotencyKey } from './api.js';

/**
 * Poll intervals. Server-Sent Events drive live updates when they are available; polling is
 * the documented fallback, so every live view still refreshes on its own.
 */
export const POLL = {
  fast: 5_000,
  normal: 10_000,
  slow: 30_000,
} as const;

interface ListResponse<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export const queryKeys = {
  me: ['me'] as const,
  projects: (params?: string) => ['projects', params ?? ''] as const,
  project: (ref: string) => ['project', ref] as const,
  health: ['shrine', 'health'] as const,
  services: ['shrine', 'services'] as const,
  jobs: (params?: string) => ['shrine', 'jobs', params ?? ''] as const,
  job: (id: string) => ['shrine', 'job', id] as const,
  events: (params?: string) => ['shrine', 'events', params ?? ''] as const,
  config: ['shrine', 'config'] as const,
  schema: ['shrine', 'schema'] as const,
  metrics: ['shrine', 'metrics'] as const,
  audit: (params?: string) => ['shrine', 'audit', params ?? ''] as const,
};

export function useMe(): UseQueryResult<MeResponse> {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.get<MeResponse>('/api/auth/me', signal),
    // The session is the gate for everything else, so never serve it from a stale cache.
    staleTime: 0,
    retry: false,
  });
}

export function useLogin(): UseMutationResult<unknown, Error, { email: string; password: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api.post('/api/auth/login', input),
    onSuccess: async () => {
      await client.invalidateQueries();
    },
  });
}

export function useLogout(): UseMutationResult<unknown, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSuccess: () => {
      client.clear();
    },
  });
}

export function useProjects(params = ''): UseQueryResult<ListResponse<ProjectSummaryDto>> {
  return useQuery({
    queryKey: queryKeys.projects(params),
    queryFn: ({ signal }) =>
      api.get<ListResponse<ProjectSummaryDto>>(`/api/projects${params}`, signal),
    refetchInterval: POLL.normal,
  });
}

export function useProject(ref: string): UseQueryResult<{ project: ProjectSummaryDto }> {
  return useQuery({
    queryKey: queryKeys.project(ref),
    queryFn: ({ signal }) =>
      api.get<{ project: ProjectSummaryDto }>(`/api/projects/${encodeURIComponent(ref)}`, signal),
    refetchInterval: POLL.normal,
    enabled: ref.length > 0,
  });
}

export function useCreateProject(): UseMutationResult<
  { project: ProjectSummaryDto },
  Error,
  { name: string; description?: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      api.post<{ project: ProjectSummaryDto }>('/api/projects', input, newIdempotencyKey()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useRenameProject(): UseMutationResult<
  { project: ProjectSummaryDto },
  Error,
  { ref: string; name: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, name }) =>
      api.patch<{ project: ProjectSummaryDto }>(`/api/projects/${encodeURIComponent(ref)}`, {
        name,
      }),
    onSuccess: async () => {
      await client.invalidateQueries();
    },
  });
}

export function useProjectLifecycle(
  action: 'archive' | 'restore',
): UseMutationResult<unknown, Error, { ref: string; reason: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, reason }) =>
      api.post(`/api/projects/${encodeURIComponent(ref)}/${action}`, { reason }),
    onSuccess: async () => {
      await client.invalidateQueries();
    },
  });
}

export function useHealth(): UseQueryResult<ShrineHealthDto> {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => api.get<ShrineHealthDto>('/api/shrine/health', signal),
    refetchInterval: POLL.normal,
  });
}

export function useMetrics(): UseQueryResult<{ metrics: MetricsSummaryDto }> {
  return useQuery({
    queryKey: queryKeys.metrics,
    queryFn: ({ signal }) =>
      api.get<{ metrics: MetricsSummaryDto }>('/api/shrine/metrics-summary', signal),
    refetchInterval: POLL.fast,
  });
}

export function useServices(): UseQueryResult<{ items: ServiceInstanceDto[] }> {
  return useQuery({
    queryKey: queryKeys.services,
    queryFn: ({ signal }) =>
      api.get<{ items: ServiceInstanceDto[] }>('/api/shrine/services', signal),
    refetchInterval: POLL.fast,
  });
}

export function useJobs(params = ''): UseQueryResult<ListResponse<JobDto>> {
  return useQuery({
    queryKey: queryKeys.jobs(params),
    queryFn: ({ signal }) => api.get<ListResponse<JobDto>>(`/api/shrine/jobs${params}`, signal),
    refetchInterval: POLL.fast,
  });
}

export function useJob(id: string): UseQueryResult<{ job: JobDto }> {
  return useQuery({
    queryKey: queryKeys.job(id),
    queryFn: ({ signal }) => api.get<{ job: JobDto }>(`/api/shrine/jobs/${id}`, signal),
    refetchInterval: POLL.fast,
    enabled: id.length > 0,
  });
}

export function useJobAction(
  action: 'retry' | 'cancel' | 'requeue',
): UseMutationResult<{ job: JobDto }, Error, { id: string; reason: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) =>
      api.post<{ job: JobDto }>(`/api/shrine/jobs/${id}/${action}`, { reason }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['shrine'] });
    },
  });
}

export function useProbeJob(): UseMutationResult<{ job: JobDto }, Error, { echo?: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input) => api.post<{ job: JobDto }>('/api/shrine/jobs/probe', input),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['shrine'] });
    },
  });
}

export function useEvents(params = ''): UseQueryResult<ListResponse<SystemEventDto>> {
  return useQuery({
    queryKey: queryKeys.events(params),
    queryFn: ({ signal }) =>
      api.get<ListResponse<SystemEventDto>>(`/api/shrine/events${params}`, signal),
    refetchInterval: POLL.fast,
  });
}

export function useShrineConfig(): UseQueryResult<{ config: ShrineConfigDto }> {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: ({ signal }) => api.get<{ config: ShrineConfigDto }>('/api/shrine/config', signal),
    refetchInterval: POLL.slow,
  });
}

export function useSchemaVersion(): UseQueryResult<{ schema: SchemaVersionDto }> {
  return useQuery({
    queryKey: queryKeys.schema,
    queryFn: ({ signal }) => api.get<{ schema: SchemaVersionDto }>('/api/shrine/schema', signal),
    refetchInterval: POLL.slow,
  });
}

export function useAuditLog(params = ''): UseQueryResult<ListResponse<AuditLogDto>> {
  return useQuery({
    queryKey: queryKeys.audit(params),
    queryFn: ({ signal }) =>
      api.get<ListResponse<AuditLogDto>>(`/api/shrine/audit${params}`, signal),
    refetchInterval: POLL.normal,
  });
}
