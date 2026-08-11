import type {
  AcquireClaimRequest,
  ActivateSessionRequest,
  ActivateSessionResponse,
  ClaimDto,
  ContextRequest,
  ContextResponse,
  CreateCheckpointRequest,
  CreateCheckpointResponse,
  EndSessionRequest,
  EndSessionResponse,
  ErrorEnvelopeDto,
  EvidenceCheckRequest,
  EvidenceCheckResponse,
  HeartbeatResponse,
  LoreEntryDto,
  LoreSearchRequest,
  LoreSearchResponse,
  MemoryUpdateDto,
  PartyStatusDto,
  ProjectDto,
  PromoteSessionRequest,
  QuestDto,
  QuestPlanDto,
  ReasonRequest,
  RememberRequest,
  ReportFingerprintsRequest,
  ReportFingerprintsResponse,
  SetQuestPlanRequest,
  StartSessionRequest,
  StartSessionResponse,
} from '@saga/contracts';
import { SagaError, backoffDelayMs, type ErrorCode } from '@saga/shared';

export interface SagaClientOptions {
  baseUrl: string;
  /** Project-scoped agent token. `SAGA_TOKEN` in CI. */
  token: string;
  /** Identifies the integration in logs and in Party. */
  client?: string;
  timeoutMs?: number;
  /** Attempts for *transient* failures only. Conflicts are never retried. */
  maxRetries?: number;
  fetch?: typeof fetch;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

/**
 * Errors a caller must handle rather than retry blindly. Retrying a conflict would either
 * lose the other party's work or spin forever, so `request` rethrows them immediately and
 * the SDK documents the recovery for each.
 */
const NEVER_RETRY: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'QUEST_REVISION_CONFLICT',
  'MEMORY_UPDATE_CONFLICT',
  'RESOURCE_CLAIM_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'MEMORY_SECRET_DETECTED',
  'SCOPE_REQUIRED',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'TOKEN_REVOKED',
  'TOKEN_EXPIRED',
  'VALIDATION_FAILED',
  'PARTY_DISABLED',
  'COORDINATION_UNAVAILABLE',
]);

export interface RequestOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * A small typed client for integrations that do not speak MCP.
 *
 * It deliberately does *not* hide conflict responses behind automatic retries: a
 * `QUEST_REVISION_CONFLICT` means the caller must re-read and decide, and swallowing it would
 * silently discard someone's work.
 */
export class SagaClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly client: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly doFetch: typeof fetch;
  private readonly onRetry: SagaClientOptions['onRetry'];

  constructor(options: SagaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.client = options.client ?? 'saga-agent-sdk';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.onRetry = options.onRetry;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const abort = () => controller.abort();
      // A signal that is *already* aborted never fires the event, so it has to be checked
      // rather than only listened to — otherwise a cancelled call still hits the network.
      if (options.signal?.aborted === true) controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });

      try {
        const headers: Record<string, string> = {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
          'x-saga-client': this.client,
        };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (options.idempotencyKey !== undefined) {
          headers['idempotency-key'] = options.idempotencyKey;
        }

        const response = await this.doFetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await response.text();
        const payload: unknown = text.length === 0 ? null : safeParse(text);

        if (response.ok) return payload as T;

        const envelope = payload as ErrorEnvelopeDto | null;
        const code = (envelope?.error?.code ?? 'INTERNAL_ERROR') as ErrorCode;
        const error = new SagaError(
          code,
          envelope?.error?.message ?? `Saga answered ${response.status}.`,
          {
            status: response.status,
            details: envelope?.error?.details ?? {},
            retryable: !NEVER_RETRY.has(code) && response.status >= 500,
          },
        );

        // `retryable` already encodes both rules: never a conflict, never a 4xx. Deciding here
        // and rethrowing every SagaError below keeps the two branches from disagreeing — an
        // earlier version re-tested only the conflict set in `catch`, so a 404 was retried
        // three times despite the check above.
        if (!error.retryable || attempt === this.maxRetries) throw error;
        lastError = error;
      } catch (error) {
        // Any SagaError reaching here was thrown deliberately above; only transport failures
        // are eligible for another attempt.
        if (error instanceof SagaError) throw error;
        if (attempt === this.maxRetries) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      }

      const delay = backoffDelayMs(attempt, Math.random(), { baseMs: 250, maxMs: 5_000 });
      this.onRetry?.(attempt, delay, lastError instanceof Error ? lastError.message : 'unknown');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw lastError instanceof Error
      ? lastError
      : new SagaError('SERVICE_UNAVAILABLE', 'Saga could not be reached.');
  }

  // --- identity ------------------------------------------------------------

  async whoami(): Promise<{
    authenticated: boolean;
    actor_type: string;
    agent: { project_id: string; name: string; scopes: string[] } | null;
  }> {
    return this.request('GET', '/api/auth/me');
  }

  async health(): Promise<{ status: string; version: string }> {
    return this.request('GET', '/api/shrine/health');
  }

  async project(ref: string): Promise<{ project: ProjectDto }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(ref)}`);
  }

  // --- sessions ------------------------------------------------------------

  async startSession(
    input: StartSessionRequest,
    options?: RequestOptions,
  ): Promise<StartSessionResponse> {
    return this.request('POST', '/api/sessions', input, options);
  }

  async activateSession(
    sessionId: string,
    input: ActivateSessionRequest,
  ): Promise<ActivateSessionResponse> {
    return this.request('POST', `/api/sessions/${sessionId}/activate`, input);
  }

  async promoteSession(
    sessionId: string,
    input: PromoteSessionRequest,
  ): Promise<ActivateSessionResponse> {
    return this.request('POST', `/api/sessions/${sessionId}/promote`, input);
  }

  async questPlan(questId: string): Promise<QuestPlanDto> {
    return this.request('GET', `/api/quests/${questId}/plan`);
  }

  /**
   * Reopen a completed or cancelled Quest. The reason is required and is recorded in the audit
   * log — this is the one way back from a close, so who did it and why has to survive.
   */
  async reopenQuest(questId: string, input: ReasonRequest): Promise<{ quest: QuestDto }> {
    return this.request('POST', `/api/quests/${questId}/reopen`, input);
  }

  /**
   * Declare or re-declare a Quest's numbered plan. Settling the last step completes the Quest,
   * on a project whose `quest_completion_mode` is `auto`.
   */
  async setQuestPlan(questId: string, input: SetQuestPlanRequest): Promise<QuestPlanDto> {
    return this.request('PUT', `/api/quests/${questId}/plan`, input);
  }

  /**
   * Record a checkpoint. A `QUEST_REVISION_CONFLICT` is rethrown with the latest revision in
   * `details` so the caller can re-read and retry deliberately.
   */
  async checkpoint(
    sessionId: string,
    input: CreateCheckpointRequest,
    options?: RequestOptions,
  ): Promise<CreateCheckpointResponse> {
    return this.request('POST', `/api/sessions/${sessionId}/checkpoints`, input, options);
  }

  async endSession(sessionId: string, input: EndSessionRequest = {}): Promise<EndSessionResponse> {
    return this.request('POST', `/api/sessions/${sessionId}/end`, input);
  }

  async sessionHeartbeat(sessionId: string): Promise<{ ok: true }> {
    return this.request('POST', `/api/sessions/${sessionId}/heartbeat`, {});
  }

  // --- lore ----------------------------------------------------------------

  async context(projectRef: string, input: ContextRequest = {}): Promise<ContextResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(projectRef)}/context`, input);
  }

  async searchLore(projectRef: string, input: LoreSearchRequest): Promise<LoreSearchResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectRef)}/lore/search`,
      input,
    );
  }

  async remember(
    projectRef: string,
    input: RememberRequest,
    options?: RequestOptions,
  ): Promise<{ update: MemoryUpdateDto; approval_mode: string; message: string }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectRef)}/lore/remember`,
      input,
      options,
    );
  }

  async loreUpdate(updateId: string): Promise<{ update: MemoryUpdateDto }> {
    return this.request('GET', `/api/lore/updates/${updateId}`);
  }

  /**
   * One page of Lore Entries. Cursor-paged, so a caller that needs all of them follows
   * `next_cursor` until `has_more` is false.
   *
   * `checkEvidence` needs this: only the entries themselves say which files they were read out
   * of, and the server never looks at the caller's filesystem.
   */
  async loreEntries(
    projectRef: string,
    query = '',
  ): Promise<{ items: LoreEntryDto[]; next_cursor: string | null; has_more: boolean }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectRef)}/lore${query}`);
  }

  async checkEvidence(
    projectRef: string,
    input: EvidenceCheckRequest,
  ): Promise<EvidenceCheckResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(projectRef)}/lore/evidence/check`,
      input,
    );
  }

  // --- quests --------------------------------------------------------------

  async quest(questId: string): Promise<{ quest: QuestDto }> {
    return this.request('GET', `/api/quests/${questId}`);
  }

  async quests(projectRef: string, query = ''): Promise<{ items: QuestDto[] }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectRef)}/quests${query}`);
  }

  // --- party ---------------------------------------------------------------

  async partyStatus(projectRef: string): Promise<PartyStatusDto> {
    return this.request('GET', `/api/projects/${encodeURIComponent(projectRef)}/party/status`);
  }

  async partyHeartbeat(
    runId: string,
    renewClaims = true,
    /** The tool the agent called since the last beat, when there was one. */
    activity: string | null = null,
  ): Promise<HeartbeatResponse> {
    return this.request('POST', `/api/party/runs/${runId}/heartbeat`, {
      renew_claims: renewClaims,
      ...(activity === null ? {} : { activity }),
    });
  }

  async claim(input: AcquireClaimRequest): Promise<{ claim: ClaimDto; warnings: string[] }> {
    return this.request('POST', '/api/party/claims', input);
  }

  async releaseClaim(
    claimId: string,
    agentRunId: string,
    reason?: string,
  ): Promise<{ claim: ClaimDto }> {
    return this.request('POST', `/api/party/claims/${claimId}/release`, {
      agent_run_id: agentRunId,
      reason,
    });
  }

  async reportFingerprints(
    runId: string,
    input: ReportFingerprintsRequest,
  ): Promise<ReportFingerprintsResponse> {
    return this.request('POST', `/api/party/runs/${runId}/fingerprints`, input);
  }

  async endAgentRun(runId: string): Promise<{ released_claims: number }> {
    return this.request('POST', `/api/party/runs/${runId}/end`, {});
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Guidance the SDK attaches to the conflict errors a caller must handle. Exported so an
 * integration can surface the same wording rather than inventing its own.
 */
export const RETRY_GUIDANCE: Partial<Record<ErrorCode, string>> = {
  QUEST_REVISION_CONFLICT:
    'Another session recorded a checkpoint first. Re-read the Quest, merge your work state with the latest checkpoint, and submit again with the new revision. Do not retry blindly.',
  MEMORY_UPDATE_CONFLICT:
    'One or more Lore Entries changed since you read them. Re-read the current versions, reapply your change, and propose again.',
  RESOURCE_CLAIM_CONFLICT:
    'Another agent holds this resource. Wait for the lease to expire, coordinate through the Quest, or work on something else. Do not proceed without the claim.',
  COORDINATION_UNAVAILABLE:
    'Coordination is unavailable for a fail-closed resource. Stop, record a checkpoint describing the waiting state, and report what is required.',
  MEMORY_SECRET_DETECTED:
    'The candidate contained a credential. Replace it with a placeholder or an environment-variable reference and propose again.',
  IDEMPOTENCY_KEY_REUSED:
    'The same Idempotency-Key was used with a different body. Generate a new key for a genuinely new request.',
};
