import type {
  CheckpointDto,
  DependencyType,
  QuestDependencyDto,
  QuestDto,
  QuestPlanDto,
  QuestPriority,
  QuestScope,
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
  /** Null when the Quest declared no plan, which is not the same as a plan with nothing done. */
  plan: QuestPlanDto | null;
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
  {
    questId: string;
    status?: QuestStatus;
    priority?: QuestPriority;
    objective?: string | null;
    scope?: QuestScope;
  }
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

export function useAddDependency(): UseMutationResult<
  { dependencies: QuestDependencyDto[] },
  Error,
  { questId: string; dependsOnWorkItemId: string; dependencyType: DependencyType }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ questId, dependsOnWorkItemId, dependencyType }) =>
      api.post<{ dependencies: QuestDependencyDto[] }>(`/api/quests/${questId}/dependencies`, {
        depends_on_work_item_id: dependsOnWorkItemId,
        dependency_type: dependencyType,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['quests'] });
    },
  });
}

export function useRemoveDependency(): UseMutationResult<
  unknown,
  Error,
  { questId: string; dependsOnWorkItemId: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ questId, dependsOnWorkItemId }) =>
      api.del(`/api/quests/${questId}/dependencies/${dependsOnWorkItemId}`),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['quests'] });
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
