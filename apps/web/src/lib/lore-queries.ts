import type {
  ContextSnapshotDto,
  LoreEntryDto,
  LoreSearchResponse,
  MemoryLinkDto,
  MemoryLinkState,
  MemoryRelation,
  MemoryUpdateDto,
  MemoryVersionDto,
} from '@saga/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api, newIdempotencyKey } from './api.js';
import { POLL } from './queries.js';

const encode = encodeURIComponent;

export const loreKeys = {
  list: (ref: string, params: string) => ['lore', 'list', ref, params] as const,
  entry: (ref: string, key: string) => ['lore', 'entry', ref, key] as const,
  versions: (ref: string, key: string) => ['lore', 'versions', ref, key] as const,
  updates: (ref: string, params: string) => ['lore', 'updates', ref, params] as const,
  links: (ref: string) => ['lore', 'links', ref] as const,
  snapshot: (ref: string) => ['lore', 'snapshot', ref] as const,
};

interface ListResponse<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
  memory_revision: number;
}

export function useLoreEntries(
  ref: string,
  params = '',
): UseQueryResult<ListResponse<LoreEntryDto>> {
  return useQuery({
    queryKey: loreKeys.list(ref, params),
    queryFn: ({ signal }) =>
      api.get<ListResponse<LoreEntryDto>>(`/api/projects/${encode(ref)}/lore${params}`, signal),
    refetchInterval: POLL.normal,
    enabled: ref.length > 0,
  });
}

export function useLoreEntry(
  ref: string,
  memoryKey: string,
): UseQueryResult<{ entry: LoreEntryDto; links: MemoryLinkDto[] }> {
  return useQuery({
    queryKey: loreKeys.entry(ref, memoryKey),
    queryFn: ({ signal }) =>
      api.get<{ entry: LoreEntryDto; links: MemoryLinkDto[] }>(
        `/api/projects/${encode(ref)}/lore/${encode(memoryKey)}`,
        signal,
      ),
    enabled: ref.length > 0 && memoryKey.length > 0,
  });
}

export function useLoreVersions(
  ref: string,
  memoryKey: string,
): UseQueryResult<{ items: MemoryVersionDto[]; current_version_id: string | null }> {
  return useQuery({
    queryKey: loreKeys.versions(ref, memoryKey),
    queryFn: ({ signal }) =>
      api.get<{ items: MemoryVersionDto[]; current_version_id: string | null }>(
        `/api/projects/${encode(ref)}/lore/${encode(memoryKey)}/versions`,
        signal,
      ),
    enabled: ref.length > 0 && memoryKey.length > 0,
  });
}

export function useLoreUpdates(
  ref: string,
  params = '',
): UseQueryResult<{ items: MemoryUpdateDto[] }> {
  return useQuery({
    queryKey: loreKeys.updates(ref, params),
    queryFn: ({ signal }) =>
      api.get<{ items: MemoryUpdateDto[] }>(
        `/api/projects/${encode(ref)}/lore-updates${params}`,
        signal,
      ),
    refetchInterval: POLL.fast,
    enabled: ref.length > 0,
  });
}

/** Defaults to the confirmed graph; pass `proposed` for the inference review queue. */
export function useLoreLinks(
  ref: string,
  state: MemoryLinkState = 'confirmed',
): UseQueryResult<{ items: MemoryLinkDto[] }> {
  return useQuery({
    queryKey: [...loreKeys.links(ref), state],
    queryFn: ({ signal }) =>
      api.get<{ items: MemoryLinkDto[] }>(
        `/api/projects/${encode(ref)}/lore-links?state=${state}`,
        signal,
      ),
    enabled: ref.length > 0,
  });
}

export function useContextSnapshot(
  ref: string,
): UseQueryResult<{ snapshot: ContextSnapshotDto | null; bootstrap_plan: unknown }> {
  return useQuery({
    queryKey: loreKeys.snapshot(ref),
    queryFn: ({ signal }) =>
      api.get<{ snapshot: ContextSnapshotDto | null; bootstrap_plan: unknown }>(
        `/api/projects/${encode(ref)}/context/snapshot`,
        signal,
      ),
    refetchInterval: POLL.normal,
    enabled: ref.length > 0,
  });
}

export function useLoreSearch(): UseMutationResult<
  LoreSearchResponse,
  Error,
  { ref: string; query: string; categories?: string[] }
> {
  return useMutation({
    mutationFn: ({ ref, query, categories }) =>
      api.post<LoreSearchResponse>(`/api/projects/${encode(ref)}/lore/search`, {
        query,
        limit: 15,
        ...(categories !== undefined && categories.length > 0 ? { filters: { categories } } : {}),
      }),
  });
}

export interface ProposeEntryInput {
  memory_key: string;
  category: string;
  kind: string;
  body: string;
  confidence: number;
  verification_state: string;
  importance?: number;
  base_version_id?: string | null;
}

export function useProposeLore(): UseMutationResult<
  { update: MemoryUpdateDto },
  Error,
  { ref: string; entries: ProposeEntryInput[]; summary: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, entries, summary }) =>
      api.post<{ update: MemoryUpdateDto }>(
        `/api/projects/${encode(ref)}/lore/remember`,
        { entries, summary },
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['lore'] });
    },
  });
}

export function useLoreUpdateAction(
  action: 'validate' | 'publish' | 'cancel',
): UseMutationResult<unknown, Error, { updateId: string; reason?: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ updateId, reason }) =>
      api.post(`/api/lore/updates/${updateId}/${action}`, action === 'cancel' ? { reason } : {}),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['lore'] });
      await client.invalidateQueries({ queryKey: ['projects'] });
      await client.invalidateQueries({ queryKey: ['project'] });
    },
  });
}

export function useCreateLoreLink(): UseMutationResult<
  { link: MemoryLinkDto },
  Error,
  { ref: string; from_memory_key: string; relation: MemoryRelation; to_memory_key: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, ...body }) =>
      api.post<{ link: MemoryLinkDto }>(`/api/projects/${encode(ref)}/lore-links`, body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['lore'] });
    },
  });
}

/** Accept a model proposal into the graph. Rejecting one is `useDeleteLoreLink`. */
export function useConfirmLoreLink(): UseMutationResult<
  { link: MemoryLinkDto },
  Error,
  { linkId: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ linkId }) =>
      api.post<{ link: MemoryLinkDto }>(`/api/lore-links/${linkId}/confirm`, {}),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['lore'] });
    },
  });
}

export function useDeleteLoreLink(): UseMutationResult<unknown, Error, { linkId: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ linkId }) => api.del(`/api/lore-links/${linkId}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['lore'] });
    },
  });
}

export function useLoreLifecycle(
  action: 'mark-stale' | 'archive',
): UseMutationResult<unknown, Error, { ref: string; memoryKey: string; reason: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, memoryKey, reason }) =>
      api.post(`/api/projects/${encode(ref)}/lore/${encode(memoryKey)}/${action}`, { reason }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['lore'] });
    },
  });
}
