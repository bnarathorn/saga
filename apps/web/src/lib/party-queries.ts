import type { ClaimDto, PartyStatusDto } from '@saga/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from './api.js';
import { POLL } from './queries.js';

const encode = encodeURIComponent;

export const partyKeys = {
  status: (ref: string) => ['party', 'status', ref] as const,
  claims: (ref: string) => ['party', 'claims', ref] as const,
};

export function usePartyStatus(ref: string): UseQueryResult<PartyStatusDto> {
  return useQuery({
    queryKey: partyKeys.status(ref),
    queryFn: ({ signal }) =>
      api.get<PartyStatusDto>(`/api/projects/${encode(ref)}/party/status`, signal),
    // Party is live state, so it refreshes faster than durable views.
    refetchInterval: POLL.fast,
    enabled: ref.length > 0,
  });
}

/** Includes finished claims: the history is what an operator reads when tracing a conflict. */
export function usePartyClaims(ref: string): UseQueryResult<{ items: ClaimDto[] }> {
  return useQuery({
    queryKey: partyKeys.claims(ref),
    queryFn: ({ signal }) =>
      api.get<{ items: ClaimDto[] }>(
        `/api/projects/${encode(ref)}/party/claims?include_finished=true`,
        signal,
      ),
    refetchInterval: POLL.normal,
    enabled: ref.length > 0,
  });
}

/**
 * Release the claim of an agent run that has stopped renewing its lease. The run id comes from
 * the claim itself, because the API refuses to release a claim on behalf of another run.
 */
export function useReleaseClaim(): UseMutationResult<
  { claim: ClaimDto },
  Error,
  { claimId: string; agentRunId: string; reason: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ claimId, agentRunId, reason }) =>
      api.post<{ claim: ClaimDto }>(`/api/party/claims/${claimId}/release`, {
        agent_run_id: agentRunId,
        reason,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['party'] });
    },
  });
}

export function useRevokeClaim(): UseMutationResult<
  { claim: ClaimDto },
  Error,
  { claimId: string; reason: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ claimId, reason }) =>
      api.post<{ claim: ClaimDto }>(`/api/party/claims/${claimId}/revoke`, {
        reason,
        confirm: true,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['party'] });
    },
  });
}

/**
 * A claim whose lease has lapsed but which the server has not swept yet still reads `active`:
 * claims are only expired lazily, when the next agent tries to acquire the same resource.
 */
export function isLeaseLapsed(claim: ClaimDto, now = Date.now()): boolean {
  return claim.state === 'active' && new Date(claim.lease_expires_at).getTime() <= now;
}
