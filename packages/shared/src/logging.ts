import { pino, stdSerializers, stdTimeFunctions, type Logger, type LoggerOptions } from 'pino';
import { redactText } from './redaction.js';

export type SagaLogger = Logger;

/**
 * Correlation fields attached to log lines.
 */
export interface LogContext {
  request_id?: string;
  correlation_id?: string;
  project_id?: string;
  session_id?: string;
  quest_id?: string;
  agent_run_id?: string;
  job_id?: string;
  job_type?: string;
  operation?: string;
  error_code?: string;
  latency_ms?: number;
  [key: string]: unknown;
}

/**
 * Paths that must never reach a log sink. Wildcards cover the arbitrary `details` bags that
 * ride along on Saga errors and job payloads.
 *
 * `body`, `work_state` and `payload` are listed wholesale rather than field by field: Lore
 * bodies and checkpoint payloads are private project content, not debugging material.
 */
const REDACT_PATHS = [
  'password',
  'passwd',
  'secret',
  'token',
  'raw_token',
  'api_key',
  'apiKey',
  'authorization',
  'credential',
  'private_key',
  'connection_string',
  'body',
  'work_state',
  'payload',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-saga-csrf"]',
  '*.password',
  '*.secret',
  '*.token',
  '*.raw_token',
  '*.api_key',
  '*.authorization',
  '*.private_key',
  '*.body',
  '*.work_state',
  'details.*.password',
  'details.*.token',
];

export interface CreateLoggerOptions {
  level?: string;
  role: 'api' | 'worker' | 'cli' | 'test';
  version: string;
  pretty?: boolean;
  destination?: NodeJS.WritableStream;
}

export function createLogger(options: CreateLoggerOptions): SagaLogger {
  const base: LoggerOptions = {
    level: options.level ?? 'info',
    base: { role: options.role, version: options.version },
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      // Explicit serializers: without them Fastify's request object logs as `{}` because its
      // useful fields are not own enumerable properties.
      req: (request: {
        method?: string;
        url?: string;
        routeOptions?: { url?: string };
        id?: string;
      }) => ({
        method: request.method,
        url: typeof request.url === 'string' ? redactText(request.url) : undefined,
        route: request.routeOptions?.url,
      }),
      res: (reply: { statusCode?: number }) => ({ status_code: reply.statusCode }),
      /**
       * Errors go through the standard serializer, then lose `details` entirely.
       *
       * pino's `redact` paths are anchored at the log object's root, so nothing in
       * `REDACT_PATHS` reaches inside `err`. `{ err }` is the dominant error-logging idiom in
       * this codebase, and `SagaError.details` is caller-supplied — its "never put secrets
       * here" rule was enforced by convention alone, with a log line one mistake away. The
       * detail keys are kept for diagnosis; the values are not.
       */
      err: (error: unknown) => {
        const serialized = stdSerializers.err(error as Error) as Record<string, unknown>;
        const details = serialized.details;
        if (details !== undefined && details !== null && typeof details === 'object') {
          serialized.details = { keys: Object.keys(details as Record<string, unknown>) };
        }
        return serialized;
      },
    },
    redact: { paths: REDACT_PATHS, censor: '[redacted]', remove: false },
  };

  if (options.pretty === true) {
    return pino({
      ...base,
      transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } },
    });
  }
  return options.destination === undefined ? pino(base) : pino(base, options.destination);
}

/** A logger that discards everything. Used by tests and by the MCP stdio server. */
export function createSilentLogger(): SagaLogger {
  return pino({ level: 'silent' });
}
