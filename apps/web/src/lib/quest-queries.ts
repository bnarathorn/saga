import type {
  CheckpointDto,
  QuestDependencyDto,
  QuestDto,
  QuestPriority,
  QuestStatus,
  SessionDto,
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

export const questKeys = {
  list: (ref: string, params: string) => ['quests', 'list', ref, params] as const,
  detail: (id: string) => ['quests', 'detail', id] as const,
};

interface ListResponse<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface QuestDetail {
  quest: QuestDto;
  children: QuestDto[];
  dependencies: QuestDependencyDto[];
  checkpoints: CheckpointDto[];
  sessions: SessionDto[];
  latest_handoff: CheckpointDto | null;
}

export function useQuests(ref: string, params = ''): UseQueryResult<ListResponse<QuestDto>> {
  return useQuery({
    queryKey: questKeys.list(ref, params),
    queryFn: ({ signal }) =>
      api.get<ListResponse<QuestDto>>(`/api/projects/${encode(ref)}/quests${params}`, signal),
    refetchInterval: POLL.normal,
    enabled: ref.length > 0,
  });
}

export function useQuestDetail(questId: string): UseQueryResult<QuestDetail> {
  return useQuery({
    queryKey: questKeys.detail(questId),
    queryFn: ({ signal }) => api.get<QuestDetail>(`/api/quests/${questId}`, signal),
    refetchInterval: POLL.normal,
    enabled: questId.length > 0,
  });
}

export function useCreateQuest(): UseMutationResult<
  { quest: QuestDto },
  Error,
  { ref: string; title: string; objective?: string; priority?: QuestPriority }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, ...body }) =>
      api.post<{ quest: QuestDto }>(
        `/api/projects/${encode(ref)}/quests`,
        body,
        newIdempotencyKey(),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['quests'] });
    },
  });
}

export function useUpdateQuest(): UseMutationResult<
  { quest: QuestDto },
  Error,
  { questId: string; status?: QuestStatus; priority?: QuestPriority; objective?: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ questId, ...body }) =>
      api.patch<{ quest: QuestDto }>(`/api/quests/${questId}`, body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['quests'] });
      await client.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useQuestLifecycle(
  action: 'archive' | 'reopen',
): UseMutationResult<{ quest: QuestDto }, Error, { questId: string; reason?: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ questId, reason }) =>
      api.post<{ quest: QuestDto }>(
        `/api/quests/${questId}/${action}`,
        action === 'reopen' ? { reason } : {},
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['quests'] });
    },
  });
}
