import type { MemoryRelation } from '@saga/contracts';

/**
 * A relation read straight out of an entry body, with the text that produced it.
 *
 * Always `relates_to`. A mention proves two entries belong together and nothing more: which of
 * the eight directed relations applies is exactly the judgement a text match cannot make, and
 * guessing `uses` from proximity would put a claim in the graph that nobody wrote.
 */
export interface ExtractedRelation {
  toMemoryKey: string;
  relation: MemoryRelation;
  /** `wikilink` for `[[key]]`, `mention` for the bare key in prose. */
  form: 'wikilink' | 'mention';
}

/** `[[some.key]]`, tolerating whitespace inside the brackets. */
const WIKILINK = /\[\[\s*([a-z0-9][a-z0-9._-]*)\s*\]\]/g;

/**
 * Every run of characters a key could be made of. The body is cut into these and each one is
 * looked up whole, rather than each known key being searched for inside the body: a substring
 * search matches `run.api` inside `run.api.local` and links every parent key to every child.
 */
const KEY_SHAPED = /[a-z0-9][a-z0-9._-]*/gi;

/**
 * `.`, `-` and `_` are legal inside a key and illegal at its end, so a trailing run of them is
 * punctuation the sentence owns, not part of the token — without this, a key ending a sentence
 * is never recognised.
 */
function trimPunctuation(token: string): string {
  return token.replace(/[._-]+$/, '');
}

/**
 * Find the relations one entry body declares about others.
 *
 * `knownKeys` is every other entry in the project; the source key itself must not be in it, or
 * an entry that names itself proposes a self-link the schema rejects. Results are deduplicated
 * by target, and a `[[key]]` beats a bare mention of the same key — the stronger signal is the
 * one worth recording.
 */
export function extractRelations(body: string, knownKeys: readonly string[]): ExtractedRelation[] {
  const known = new Set(knownKeys);
  const byKey = new Map<string, ExtractedRelation>();

  for (const match of body.matchAll(WIKILINK)) {
    const key = match[1]!;
    // A `[[key]]` naming an entry that does not exist is a dangling link, not a relation.
    if (!known.has(key)) continue;
    byKey.set(key, { toMemoryKey: key, relation: 'relates_to', form: 'wikilink' });
  }

  for (const match of body.matchAll(KEY_SHAPED)) {
    const token = trimPunctuation(match[0].toLowerCase());
    if (!known.has(token) || byKey.has(token)) continue;
    byKey.set(token, { toMemoryKey: token, relation: 'relates_to', form: 'mention' });
  }

  return [...byKey.values()].sort((a, b) => a.toMemoryKey.localeCompare(b.toMemoryKey));
}
