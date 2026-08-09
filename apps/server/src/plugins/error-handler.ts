import { METRIC, metrics, SagaError, errorMessage, isSagaError, redactText } from '@saga/shared';
import type { FastifyInstance } from 'fastify';

interface FastifyErrorish {
  statusCode?: number;
  code?: string;
  validation?: unknown;
}

/**
 * Every error leaving the API is a Saga envelope with a stable code and the request id.
 * Internal details are logged, never returned.
 */
export function registerErrorHandler(app: FastifyInstance, exposeInternals: boolean): void {
  app.setNotFoundHandler((request, reply) => {
    const error = new SagaError('NOT_FOUND', `No route matches ${request.method} ${request.url}.`);
    metrics.increment(`${METRIC.httpErrorPrefix}${error.code}`);
    void reply.status(404).send(error.toEnvelope(request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const sagaError = toSagaError(error);
    // Counted by stable code, never by message: the code is the contract (§12).
    metrics.increment(`${METRIC.httpErrorPrefix}${sagaError.code}`);

    const logPayload = {
      request_id: request.id,
      error_code: sagaError.code,
      operation: `${request.method} ${request.routeOptions?.url ?? request.url}`,
      status: sagaError.status,
    };

    if (sagaError.status >= 500) {
      request.log.error({ ...logPayload, err: error }, 'request failed');
    } else if (isSagaError(error)) {
      // Saga raised this itself, so the code and the message are the whole story.
      request.log.warn(logPayload, 'request rejected');
    } else {
      // Something else — Fastify, or PostgreSQL — that `toSagaError` mapped down to a 4xx. The
      // mapped message is deliberately generic, so without the original the log would say a
      // request was rejected and nothing about what failed.
      request.log.warn({ ...logPayload, err: error }, 'request rejected');
    }

    const envelope = sagaError.toEnvelope(request.id);
    if (sagaError.status >= 500 && !exposeInternals) {
      envelope.error.message =
        'An internal error occurred. The request id identifies it in the logs.';
      envelope.error.details = {};
    }

    void reply.status(sagaError.status).send(envelope);
  });
}

function toSagaError(error: unknown): SagaError {
  if (isSagaError(error)) return error;

  const shape = error as FastifyErrorish;

  // PostgreSQL 22P02 — a value that did not parse as its column type. Every value that reaches
  // SQL here came from the request, and the one that actually happens is a path id that is not
  // a uuid: `/api/lore-links/not-a-uuid`. Answering 500 both misreports a malformed request as
  // a server fault and files it under INTERNAL_ERROR in the error metrics, where it is
  // indistinguishable from a real outage.
  if (shape.code === '22P02') {
    return new SagaError('BAD_REQUEST', 'A value in the request is not of the expected type.');
  }

  // Fastify's own errors carry a statusCode; map the ones a client can act on.
  if (typeof shape.statusCode === 'number') {
    if (shape.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || shape.statusCode === 413) {
      return new SagaError('BAD_REQUEST', 'The request body is larger than the configured limit.', {
        status: 413,
      });
    }
    if (shape.statusCode === 429) {
      return new SagaError('RATE_LIMITED', 'Too many requests. Slow down and retry later.');
    }
    if (shape.statusCode >= 400 && shape.statusCode < 500) {
      return new SagaError('BAD_REQUEST', redactText(errorMessage(error)), {
        status: shape.statusCode,
      });
    }
  }

  return new SagaError('INTERNAL_ERROR', redactText(errorMessage(error)), { cause: error });
}
