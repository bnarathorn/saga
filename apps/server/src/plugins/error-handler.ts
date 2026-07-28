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
    } else {
      request.log.warn(logPayload, 'request rejected');
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
