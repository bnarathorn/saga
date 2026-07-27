import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHANNEL_WEIGHTS,
  RRF_K,
  applyQuality,
  expandByRelations,
  fuseByReciprocalRank,
  qualityFactor,
  type RelationEdge,
} from './fusion.js';

describe('reciprocal rank fusion', () => {
  it('ranks an entry found by several channels above one found by a single channel', () => {
    const fused = fuseByReciprocalRank([
      { channel: 'fulltext', ids: ['a', 'b', 'c'] },
      { channel: 'vector', ids: ['c', 'a', 'd'] },
    ]);
    expect(fused[0]?.id).toBe('a');
    expect(fused[0]?.matchedBy.sort()).toEqual(['fulltext', 'vector']);
  });

  it('computes the documented formula', () => {
    const fused = fuseByReciprocalRank([{ channel: 'fulltext', ids: ['a', 'b'] }]);
    expect(fused[0]?.score).toBeCloseTo(DEFAULT_CHANNEL_WEIGHTS.fulltext / (RRF_K + 1), 12);
    expect(fused[1]?.score).toBeCloseTo(DEFAULT_CHANNEL_WEIGHTS.fulltext / (RRF_K + 2), 12);
  });

  it('weights channels as configured', () => {
    const fused = fuseByReciprocalRank([
      { channel: 'trigram', ids: ['t'] },
      { channel: 'fulltext', ids: ['f'] },
    ]);
    // Same rank in both channels, so the heavier channel must win.
    expect(fused[0]?.id).toBe('f');
  });

  it('ignores a channel with zero weight', () => {
    const fused = fuseByReciprocalRank([{ channel: 'trigram', ids: ['t'] }], {
      ...DEFAULT_CHANNEL_WEIGHTS,
      trigram: 0,
    });
    expect(fused).toEqual([]);
  });

  it('degrades cleanly when the vector channel returns nothing', () => {
    const withVector = fuseByReciprocalRank([
      { channel: 'fulltext', ids: ['a', 'b'] },
      { channel: 'vector', ids: ['b'] },
    ]);
    const withoutVector = fuseByReciprocalRank([
      { channel: 'fulltext', ids: ['a', 'b'] },
      { channel: 'vector', ids: [] },
    ]);
    expect(withoutVector.map((result) => result.id)).toEqual(['a', 'b']);
    expect(withVector.map((result) => result.id)).toEqual(['b', 'a']);
  });

  it('is deterministic for identical inputs, including ties', () => {
    const channels = [
      { channel: 'fulltext' as const, ids: ['z', 'y'] },
      { channel: 'vector' as const, ids: ['y', 'z'] },
    ];
    const first = fuseByReciprocalRank(channels).map((result) => result.id);
    const second = fuseByReciprocalRank(channels).map((result) => result.id);
    expect(first).toEqual(second);
    // Perfect tie: the id breaks it, ascending.
    expect(first).toEqual(['y', 'z']);
  });

  it('returns nothing when every channel is empty', () => {
    expect(fuseByReciprocalRank([{ channel: 'fulltext', ids: [] }])).toEqual([]);
    expect(fuseByReciprocalRank([])).toEqual([]);
  });
});

describe('quality factor', () => {
  const base = {
    importance: 50,
    verificationState: 'observed' as const,
    state: 'active' as const,
    volatility: 'stable' as const,
    lastVerifiedAt: null,
    now: new Date('2026-01-01T00:00:00Z'),
  };

  it('scales with importance', () => {
    expect(qualityFactor({ ...base, importance: 0 })).toBeCloseTo(0.75, 10);
    expect(qualityFactor({ ...base, importance: 100 })).toBeCloseTo(1.25, 10);
    expect(qualityFactor({ ...base, importance: 50 })).toBeCloseTo(1.0, 10);
  });

  it('prefers verified over observed over inferred', () => {
    const verified = qualityFactor({ ...base, verificationState: 'verified' });
    const observed = qualityFactor({ ...base, verificationState: 'observed' });
    const inferred = qualityFactor({ ...base, verificationState: 'inferred' });
    expect(verified).toBeGreaterThan(observed);
    expect(observed).toBeGreaterThan(inferred);
  });

  it('penalises a stale entry without removing it', () => {
    const stale = qualityFactor({ ...base, state: 'stale' });
    expect(stale).toBeCloseTo(0.6, 10);
    expect(stale).toBeGreaterThan(0);
  });

  it('expires operational knowledge faster than stable knowledge', () => {
    const verifiedAt = new Date('2025-12-01T00:00:00Z'); // 31 days earlier
    const operational = qualityFactor({ ...base, volatility: 'operational', lastVerifiedAt: verifiedAt });
    const stable = qualityFactor({ ...base, volatility: 'stable', lastVerifiedAt: verifiedAt });
    expect(operational).toBeLessThan(stable);
    expect(stable).toBeCloseTo(1.0, 10);
  });

  it('clamps an out-of-range importance rather than producing a wild multiplier', () => {
    expect(qualityFactor({ ...base, importance: 1_000 })).toBeCloseTo(1.25, 10);
    expect(qualityFactor({ ...base, importance: -50 })).toBeCloseTo(0.75, 10);
  });

  it('reorders equal matches by quality', () => {
    const fused = fuseByReciprocalRank([{ channel: 'fulltext', ids: ['low', 'high'] }]);
    const scored = applyQuality(fused, (id) => ({
      ...base,
      importance: id === 'high' ? 100 : 0,
    }));
    expect(scored[0]?.id).toBe('high');
  });
});

describe('relation expansion', () => {
  const seeds = [{ id: 'server.api', score: 1, matchedBy: ['fulltext' as const] }];
  const edges: RelationEdge[] = [
    { fromId: 'server.api', toId: 'database.primary', relation: 'uses' },
    { fromId: 'database.primary', toId: 'config.local', relation: 'configured_by' },
    { fromId: 'config.local', toId: 'server.api', relation: 'relates_to' },
  ];

  it('does nothing at depth zero', () => {
    const result = expandByRelations(seeds, edges, { depth: 0, maxResults: 20 });
    expect(result.map((hit) => hit.id)).toEqual(['server.api']);
  });

  it('expands exactly one hop by default', () => {
    const result = expandByRelations(seeds, edges, { depth: 1, maxResults: 20 });
    expect(result.map((hit) => hit.id).sort()).toEqual(['database.primary', 'server.api']);
    const expanded = result.find((hit) => hit.id === 'database.primary');
    expect(expanded?.viaRelation).toEqual({ fromId: 'server.api', relation: 'uses' });
    expect(expanded?.score).toBeCloseTo(0.5, 10);
  });

  it('expands two hops when asked, decaying each time', () => {
    const result = expandByRelations(seeds, edges, { depth: 2, maxResults: 20 });
    expect(result.map((hit) => hit.id).sort()).toEqual([
      'config.local',
      'database.primary',
      'server.api',
    ]);
    expect(result.find((hit) => hit.id === 'config.local')?.score).toBeCloseTo(0.25, 10);
  });

  it('terminates on a cycle instead of looping forever', () => {
    const result = expandByRelations(seeds, edges, { depth: 5, maxResults: 50 });
    expect(result.filter((hit) => hit.id === 'server.api')).toHaveLength(1);
    expect(result).toHaveLength(3);
  });

  it('respects the hard result cap', () => {
    const many: RelationEdge[] = Array.from({ length: 100 }, (_, index) => ({
      fromId: 'server.api',
      toId: `neighbour-${index}`,
      relation: 'relates_to',
    }));
    const result = expandByRelations(seeds, many, { depth: 1, maxResults: 5 });
    expect(result).toHaveLength(5);
  });

  it('keeps a directly matched entry ahead of an entry reached via a relation', () => {
    const twoSeeds = [
      { id: 'a', score: 1, matchedBy: ['fulltext' as const] },
      { id: 'b', score: 0.9, matchedBy: ['vector' as const] },
    ];
    const result = expandByRelations(twoSeeds, [{ fromId: 'a', toId: 'c', relation: 'uses' }], {
      depth: 1,
      maxResults: 10,
    });
    expect(result.map((hit) => hit.id)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic when several edges leave the same node', () => {
    const branching: RelationEdge[] = [
      { fromId: 'server.api', toId: 'zzz', relation: 'uses' },
      { fromId: 'server.api', toId: 'aaa', relation: 'uses' },
    ];
    const first = expandByRelations(seeds, branching, { depth: 1, maxResults: 2 });
    const second = expandByRelations(seeds, branching, { depth: 1, maxResults: 2 });
    expect(first).toEqual(second);
  });
});
