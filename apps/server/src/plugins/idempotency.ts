import type { IdempotencyRepository } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { SagaError, addSeconds } from '@saga/shared';
import { sha256Hex } from '@saga/shared/ids';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface IdempotencyDeps {
  pool: SagaPool;
  records: IdempotencyRepository;
  retentionHours: number;
}

/**
 * Persisted idempotency for retryable mutations.
 *
 * - No `Idempotency-Key` header → run normally.
 * - First use of a key → reserve it, run the operation, store the response.
 * - Replay with the same body → return the stored response verbatim.
 * - Replay with a *different* body → 409 `IDEMPOTENCY_KEY_REUSED`, because the caller almost
 *   certainly has a bug and silently returning the old response would hide it.
 * - Replay while the first attempt is still running → 409 `IDEMPOTENCY_IN_PROGRESS`.
 */
export async function withIdempotency<T>(
  deps: IdempotencyDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  operation: string,
  run: () => Promise<{ status: number; body: T; resourceId?: string | null }>,
): Promise<T> {
  const header = request.headers['idempotency-key'];
  const key = typeof header === 'string' ? header.trim() : '';

  if (key.length === 0) {
    const result = await run();
    void reply.status(result.status);
    return result.body;
  }

  if (key.length < 8 || key.length > 200) {
    throw new SagaError('BAD_REQUEST', 'Idempotency-Key must be between 8 and 200 characters.');
  }

  const requestHash = sha256Hex(JSON.stringify(request.body ?? null));
  const reservation = await deps.records.reserve(deps.pool, {
    actorKey: request.actorKey,
    operation,
    idempotencyKey: key,
    requestHash,
    expiresAt: addSeconds(new Date(), deps.retentionHours * 3_600),
  });

  if (!reservation.reserved) {
    const existing = reservation.existing;
    if (existing === null) {
      throw new SagaError('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is in progress.');
    }
    if (existing.requestHash !== requestHash) {
      throw new SagaError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request body.',
        { details: { operation, idempotency_key: key } },
      );
    }
    if (existing.state === 'in_progress') {
      throw new SagaError(
        'IDEMPOTENCY_IN_PROGRESS',
        'An identical request with this Idempotency-Key is still being processed. Retry shortly.',
      );
    }
    void reply.status(existing.responseStatus ?? 200);
    void reply.header('idempotency-replayed', 'true');
    return existing.responseBody as T;
  }

  const recordId = reservation.existing!.id;
  try {
    const result = await run();
    await deps.records.complete(
      deps.pool,
      recordId,
      result.status,
      result.body,
      result.resourceId ?? null,
    );
    void reply.status(result.status);
    return result.body;
  } catch (error) {
    // Release the reservation so the caller may retry the same key after fixing the cause.
    await deps.records.release(deps.pool, recordId);
    throw error;
  }
}
