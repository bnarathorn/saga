import { describe, expect, it } from 'vitest';
import { extractRelations } from './extract.js';

const KEYS = ['decision.quest_completion', 'run.api', 'run.api.local', 'database.primary'];

describe('extractRelations', () => {
  it('reads a wiki-link as a relation', () => {
    const found = extractRelations('Forward-only. See [[decision.quest_completion]].', KEYS);
    expect(found).toEqual([
      { toMemoryKey: 'decision.quest_completion', relation: 'relates_to', form: 'wikilink' },
    ]);
  });

  it('tolerates whitespace inside the brackets', () => {
    const found = extractRelations('See [[ run.api ]].', KEYS);
    expect(found.map((entry) => entry.toMemoryKey)).toEqual(['run.api']);
  });

  it('ignores a wiki-link to an entry that does not exist', () => {
    expect(extractRelations('See [[no.such.entry]].', KEYS)).toEqual([]);
  });

  it('reads a bare key in prose as a mention', () => {
    const found = extractRelations('The pool is owned by database.primary.', KEYS);
    expect(found).toEqual([
      { toMemoryKey: 'database.primary', relation: 'relates_to', form: 'mention' },
    ]);
  });

  it('matches a key wrapped in backticks', () => {
    const found = extractRelations('Set it in `run.api`.', KEYS);
    expect(found.map((entry) => entry.form)).toEqual(['mention']);
  });

  it('never matches a key inside a longer key', () => {
    // `run.api` is a prefix of `run.api.local`, and only the longer one is present.
    const found = extractRelations('Start it with run.api.local first.', KEYS);
    expect(found.map((entry) => entry.toMemoryKey)).toEqual(['run.api.local']);
  });

  it('prefers the wiki-link when a key appears in both forms', () => {
    const found = extractRelations('See [[run.api]]; run.api is the entry point.', KEYS);
    expect(found).toEqual([{ toMemoryKey: 'run.api', relation: 'relates_to', form: 'wikilink' }]);
  });

  it('reports each target once however often it appears', () => {
    const found = extractRelations('database.primary, then database.primary again.', KEYS);
    expect(found).toHaveLength(1);
  });

  it('always reports relates_to, never a directed relation', () => {
    const found = extractRelations('run.api uses database.primary and calls run.api.local.', KEYS);
    expect(found.every((entry) => entry.relation === 'relates_to')).toBe(true);
  });

  it('cannot tell a mention from a denial', () => {
    // Documented, not desired: a bare mention records that two entries were named together, and
    // prose that says the opposite reads identically. This is the cost of matching bare keys,
    // and it is why only `relates_to` is ever produced.
    const found = extractRelations('`run.api` never imports database.primary.', KEYS);
    expect(found.map((entry) => entry.toMemoryKey)).toEqual(['database.primary', 'run.api']);
  });

  it('returns nothing for an empty body or no known keys', () => {
    expect(extractRelations('', KEYS)).toEqual([]);
    expect(extractRelations('run.api', [])).toEqual([]);
  });
});
