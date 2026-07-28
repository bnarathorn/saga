import { SagaError } from '@saga/shared';

export const MAX_PROJECT_NAME_LENGTH = 200;

/**
 * Canonical project-name normalization. Names that a human would read as the same project
 * must collide on `name_key`:
 *
 *   1. Unicode NFKC normalization  (full-width forms, ligatures, NBSP → space)
 *   2. trim leading and trailing whitespace
 *   3. collapse runs of whitespace to a single space
 *   4. lowercase (Unicode-aware via `toLowerCase`)
 *
 * The display `name` keeps the user's original spelling; only `name_key` is normalized.
 */
export function normalizeProjectName(input: string): string {
  return input.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Trim and collapse whitespace for storage as the display name, without case folding. */
export function canonicalDisplayName(input: string): string {
  return input.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function assertValidProjectName(input: string): string {
  const display = canonicalDisplayName(input);
  if (display.length === 0) {
    throw new SagaError('PROJECT_NAME_INVALID', 'A project name cannot be empty or whitespace.');
  }
  if (display.length > MAX_PROJECT_NAME_LENGTH) {
    throw new SagaError(
      'PROJECT_NAME_INVALID',
      `A project name may be at most ${MAX_PROJECT_NAME_LENGTH} characters.`,
      { details: { length: display.length, max: MAX_PROJECT_NAME_LENGTH } },
    );
  }
  // Control characters would make a name unusable in a URL, a log line or a terminal.
  if (/[\p{Cc}\p{Cf}]/u.test(display)) {
    throw new SagaError(
      'PROJECT_NAME_INVALID',
      'A project name cannot contain control or formatting characters.',
    );
  }
  if (normalizeProjectName(display).length === 0) {
    throw new SagaError('PROJECT_NAME_INVALID', 'A project name must contain visible characters.');
  }
  return display;
}

/** Memory keys are lowercase dot-separated identifiers. */
export const MEMORY_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_MEMORY_KEY_LENGTH = 120;

export function assertValidMemoryKey(key: string): string {
  if (key.length === 0 || key.length > MAX_MEMORY_KEY_LENGTH) {
    throw new SagaError(
      'MEMORY_KEY_INVALID',
      `A memory key must be between 1 and ${MAX_MEMORY_KEY_LENGTH} characters.`,
      { details: { memory_key: key } },
    );
  }
  if (!MEMORY_KEY_RE.test(key)) {
    throw new SagaError(
      'MEMORY_KEY_INVALID',
      'A memory key must be lowercase and may contain only letters, digits, dots, hyphens and underscores, starting with a letter or digit.',
      { details: { memory_key: key, pattern: MEMORY_KEY_RE.source } },
    );
  }
  if (key.includes('..')) {
    throw new SagaError('MEMORY_KEY_INVALID', 'A memory key cannot contain an empty segment.', {
      details: { memory_key: key },
    });
  }
  if (key.endsWith('.')) {
    throw new SagaError('MEMORY_KEY_INVALID', 'A memory key cannot end with a dot.', {
      details: { memory_key: key },
    });
  }
  return key;
}

export function isValidMemoryKey(key: string): boolean {
  try {
    assertValidMemoryKey(key);
    return true;
  } catch {
    return false;
  }
}
