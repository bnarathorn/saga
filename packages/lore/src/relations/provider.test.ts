import { describe, expect, it } from 'vitest';
import { NullRelationProposer, parseProposals } from './provider.js';

const ALLOWED = new Set(['database.primary', 'run.api.local']);

function completion(relations: unknown): string {
  return JSON.stringify({ relations });
}

describe('parseProposals', () => {
  it('accepts a well-formed proposal', () => {
    const found = parseProposals(
      completion([
        {
          to_memory_key: 'database.primary',
          relation: 'depends_on',
          confidence: 0.8,
          rationale: 'The API reads its pool from it.',
        },
      ]),
      ALLOWED,
      'server.api',
    );
    expect(found).toEqual([
      {
        toMemoryKey: 'database.primary',
        relation: 'depends_on',
        confidence: 0.8,
        rationale: 'The API reads its pool from it.',
      },
    ]);
  });

  it('drops a key that was never offered as a candidate', () => {
    const found = parseProposals(
      completion([
        { to_memory_key: 'invented.key', relation: 'uses', confidence: 0.9, rationale: 'x' },
      ]),
      ALLOWED,
      'server.api',
    );
    expect(found).toEqual([]);
  });

  it('drops a relation outside the allowed set', () => {
    const found = parseProposals(
      completion([
        {
          to_memory_key: 'database.primary',
          relation: 'talks_to',
          confidence: 0.9,
          rationale: 'x',
        },
      ]),
      ALLOWED,
      'server.api',
    );
    expect(found).toEqual([]);
  });

  it('drops a self-link even when the model names the subject', () => {
    const found = parseProposals(
      completion([
        { to_memory_key: 'server.api', relation: 'uses', confidence: 0.9, rationale: 'x' },
      ]),
      new Set(['server.api', 'database.primary']),
      'server.api',
    );
    expect(found).toEqual([]);
  });

  it('drops a confidence that is missing, non-numeric or out of range', () => {
    const rows = [
      { to_memory_key: 'database.primary', relation: 'uses', rationale: 'x' },
      { to_memory_key: 'database.primary', relation: 'uses', confidence: 'high', rationale: 'x' },
      { to_memory_key: 'database.primary', relation: 'uses', confidence: 1.4, rationale: 'x' },
      { to_memory_key: 'database.primary', relation: 'uses', confidence: -0.1, rationale: 'x' },
    ];
    for (const row of rows) {
      expect(parseProposals(completion([row]), ALLOWED, 'server.api')).toEqual([]);
    }
  });

  it('keeps only the first proposal per target', () => {
    const found = parseProposals(
      completion([
        { to_memory_key: 'database.primary', relation: 'uses', confidence: 0.9, rationale: 'a' },
        { to_memory_key: 'database.primary', relation: 'calls', confidence: 0.7, rationale: 'b' },
      ]),
      ALLOWED,
      'server.api',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.relation).toBe('uses');
  });

  it('tolerates a missing rationale', () => {
    const found = parseProposals(
      completion([{ to_memory_key: 'run.api.local', relation: 'uses', confidence: 0.7 }]),
      ALLOWED,
      'server.api',
    );
    expect(found[0]?.rationale).toBe('');
  });

  it('returns nothing for output that is not the expected JSON', () => {
    expect(parseProposals('not json at all', ALLOWED, 'server.api')).toEqual([]);
    expect(parseProposals('{"relations":"lots"}', ALLOWED, 'server.api')).toEqual([]);
    expect(parseProposals('{}', ALLOWED, 'server.api')).toEqual([]);
    expect(parseProposals('null', ALLOWED, 'server.api')).toEqual([]);
    expect(parseProposals(completion([null, 42, 'x']), ALLOWED, 'server.api')).toEqual([]);
  });
});

describe('NullRelationProposer', () => {
  it('reports healthy, because proposing nothing is its job', async () => {
    // Degraded here would fire on every default install and train operators to ignore the check.
    const health = await new NullRelationProposer().healthCheck();
    expect(health.status).toBe('healthy');
    expect(health.message).toContain('SAGA_INFERENCE_PROVIDER=fake');
  });

  it('proposes nothing, which is what makes it the default', async () => {
    const proposer = new NullRelationProposer();
    const proposed = await proposer.propose({ memoryKey: 'server.api', body: 'anything' }, [
      { memoryKey: 'database.primary', body: 'anything' },
    ]);
    expect(proposed).toEqual([]);
  });
});
