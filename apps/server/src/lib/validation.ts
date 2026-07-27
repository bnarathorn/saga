import { SagaError } from '@saga/shared';
import type { z } from 'zod';

/**
 * Validate an external input with a Zod schema and translate failures into Saga's stable
 * error envelope. Route handlers never receive unvalidated data.
 */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  what: 'body' | 'query' | 'params' | 'headers' = 'body',
): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));

  throw new SagaError(
    what === 'body' ? 'VALIDATION_FAILED' : 'BAD_REQUEST',
    `The request ${what} is invalid: ${issues.map((issue) => `${issue.path || what} ${issue.message}`).join('; ')}`,
    { details: { location: what, issues } },
  );
}

/**
 * Validate a response against its contract in development and test. In production this is a
 * no-op so a contract drift cannot take the API down — it is a CI failure, not a runtime one.
 */
export function assertResponse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  route: string,
  enabled: boolean,
): z.infer<T> {
  if (!enabled) return value as z.infer<T>;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SagaError('INTERNAL_ERROR', `Response for ${route} does not match its contract.`, {
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }
  return result.data;
}
