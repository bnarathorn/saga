/**
 * Stable, machine-readable error codes. These are part of Saga's public contract:
 * human-readable messages may change, codes may not.
 */
export const ERROR_CODES = [
  // --- generic ---
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'NOT_IMPLEMENTED',

  // --- idempotency ---
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',

  // --- core / projects ---
  'PROJECT_NOT_FOUND',
  'PROJECT_NAME_CONFLICT',
  'PROJECT_ARCHIVED',
  'PROJECT_NAME_INVALID',

  // --- security ---
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'CSRF_TOKEN_INVALID',
  'TOKEN_REVOKED',
  'TOKEN_EXPIRED',
  'SCOPE_REQUIRED',
  'PROJECT_SCOPE_MISMATCH',
  'DEVICE_CODE_INVALID',
  'DEVICE_CODE_EXPIRED',
  'DEVICE_CODE_PENDING',
  'AUDIT_REASON_REQUIRED',

  // --- lore ---
  'MEMORY_KEY_INVALID',
  'MEMORY_ITEM_NOT_FOUND',
  'MEMORY_UPDATE_NOT_FOUND',
  'MEMORY_UPDATE_STATE_INVALID',
  'MEMORY_UPDATE_CONFLICT',
  'MEMORY_VERSION_NOT_FOUND',
  'MEMORY_SECRET_DETECTED',
  'MEMORY_BODY_TOO_LARGE',
  'MEMORY_LINK_INVALID',
  'MEMORY_EMBEDDING_NOT_READY',
  'CONTEXT_SNAPSHOT_NOT_READY',
  'EMBEDDING_DIMENSION_MISMATCH',
  'EMBEDDING_PROVIDER_UNAVAILABLE',

  // --- quest ---
  'QUEST_NOT_FOUND',
  'QUEST_REVISION_CONFLICT',
  'QUEST_STATE_INVALID',
  'QUEST_PARENT_INVALID',
  'QUEST_DEPENDENCY_INVALID',
  'SESSION_NOT_FOUND',
  'SESSION_STATE_INVALID',
  'CHECKPOINT_INVALID',

  // --- party ---
  'PARTY_DISABLED',
  'AGENT_RUN_NOT_FOUND',
  'AGENT_RUN_EXPIRED',
  'RESOURCE_CLAIM_CONFLICT',
  'CLAIM_NOT_FOUND',
  'CLAIM_NOT_OWNED',
  'CLAIM_STATE_INVALID',
  'COORDINATION_UNAVAILABLE',

  // --- shrine ---
  'JOB_NOT_FOUND',
  'JOB_STATE_INVALID',
  'JOB_CLAIM_LOST',
  'SCHEMA_VERSION_MISMATCH',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  NOT_IMPLEMENTED: 501,

  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,

  PROJECT_NOT_FOUND: 404,
  PROJECT_NAME_CONFLICT: 409,
  PROJECT_ARCHIVED: 422,
  PROJECT_NAME_INVALID: 422,

  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 429,
  CSRF_TOKEN_INVALID: 403,
  TOKEN_REVOKED: 401,
  TOKEN_EXPIRED: 401,
  SCOPE_REQUIRED: 403,
  PROJECT_SCOPE_MISMATCH: 403,
  DEVICE_CODE_INVALID: 400,
  DEVICE_CODE_EXPIRED: 400,
  DEVICE_CODE_PENDING: 202,
  AUDIT_REASON_REQUIRED: 422,

  MEMORY_KEY_INVALID: 422,
  MEMORY_ITEM_NOT_FOUND: 404,
  MEMORY_UPDATE_NOT_FOUND: 404,
  MEMORY_UPDATE_STATE_INVALID: 422,
  MEMORY_UPDATE_CONFLICT: 409,
  MEMORY_VERSION_NOT_FOUND: 404,
  MEMORY_SECRET_DETECTED: 422,
  MEMORY_BODY_TOO_LARGE: 422,
  MEMORY_LINK_INVALID: 422,
  MEMORY_EMBEDDING_NOT_READY: 409,
  CONTEXT_SNAPSHOT_NOT_READY: 409,
  EMBEDDING_DIMENSION_MISMATCH: 422,
  EMBEDDING_PROVIDER_UNAVAILABLE: 503,

  QUEST_NOT_FOUND: 404,
  QUEST_REVISION_CONFLICT: 409,
  QUEST_STATE_INVALID: 422,
  QUEST_PARENT_INVALID: 422,
  QUEST_DEPENDENCY_INVALID: 422,
  SESSION_NOT_FOUND: 404,
  SESSION_STATE_INVALID: 422,
  CHECKPOINT_INVALID: 422,

  PARTY_DISABLED: 503,
  AGENT_RUN_NOT_FOUND: 404,
  AGENT_RUN_EXPIRED: 409,
  RESOURCE_CLAIM_CONFLICT: 409,
  CLAIM_NOT_FOUND: 404,
  CLAIM_NOT_OWNED: 403,
  CLAIM_STATE_INVALID: 422,
  COORDINATION_UNAVAILABLE: 503,

  JOB_NOT_FOUND: 404,
  JOB_STATE_INVALID: 422,
  JOB_CLAIM_LOST: 409,
  SCHEMA_VERSION_MISMATCH: 503,
};

export type ErrorDetails = Record<string, unknown>;

export interface SagaErrorOptions {
  /** Extra machine-readable context. Must never contain secrets or raw Lore bodies. */
  details?: ErrorDetails;
  /** Overrides the code's default HTTP status. */
  status?: number;
  cause?: unknown;
  /** Marks the failure as safe to retry by the caller (used by the worker and CLI). */
  retryable?: boolean;
}

/** The only error type Saga services throw across a boundary. */
export class SagaError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: SagaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SagaError';
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? this.status >= 500;
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        request_id: requestId,
      },
    };
  }
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: ErrorDetails;
    request_id: string;
  };
}

export function isSagaError(value: unknown): value is SagaError {
  return value instanceof SagaError;
}

export function defaultStatusFor(code: ErrorCode): number {
  return DEFAULT_STATUS[code];
}

/** Narrow an unknown thrown value to a message without ever leaking a stack to the client. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return 'Unknown error';
}

export const notFound = (code: ErrorCode, message: string, details?: ErrorDetails): SagaError =>
  new SagaError(code, message, { details });

export const conflict = (code: ErrorCode, message: string, details?: ErrorDetails): SagaError =>
  new SagaError(code, message, { details });

export const invalid = (code: ErrorCode, message: string, details?: ErrorDetails): SagaError =>
  new SagaError(code, message, { details });
