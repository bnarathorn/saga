import { SagaError } from './errors.js';

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Opaque keyset cursor. Encoded rather than signed: it carries only ordering keys that are
 * already visible in the response, so tampering can reorder a caller's own page and nothing else.
 */
export interface CursorPayload {
  /** Primary sort value, e.g. an ISO timestamp or a numeric string. */
  k: string;
  /** Tiebreaker, always the row id. */
  id: string;
}

// Browser-safe base64url without Buffer.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function base64UrlDecode(input: string): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of input) {
    const index = B64_ALPHABET.indexOf(char);
    if (index < 0) throw new SagaError('BAD_REQUEST', 'The pagination cursor is malformed.');
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

export function encodeCursor(payload: CursorPayload): string {
  return base64UrlEncode(JSON.stringify(payload));
}

export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(cursor));
  } catch {
    throw new SagaError('BAD_REQUEST', 'The pagination cursor is malformed.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as CursorPayload).k !== 'string' ||
    typeof (parsed as CursorPayload).id !== 'string'
  ) {
    throw new SagaError('BAD_REQUEST', 'The pagination cursor is malformed.');
  }
  return parsed as CursorPayload;
}

export function clampPageSize(requested: number | undefined | null): number {
  if (requested === undefined || requested === null || Number.isNaN(requested)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)));
}

/**
 * Build a page from `limit + 1` fetched rows: the extra row proves there is more to read
 * without a second COUNT query.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => CursorPayload,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    has_more: hasMore,
    next_cursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
  };
}
