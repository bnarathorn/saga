import type { VerificationState } from '@saga/contracts';

/**
 * Reciprocal rank fusion (ADR-0008).
 *
 * The three retrieval channels produce scores on incomparable scales — `ts_rank_cd` is
 * unbounded, `similarity` is [0,1], cosine distance is [0,2] — so Saga fuses by *rank*.
 * A channel that returned nothing (no embedding provider, no trigram match) simply
 * contributes nothing, which is what makes search degrade instead of fail.
 */
export type SearchChannel = 'fulltext' | 'trigram' | 'vector';

export const RRF_K = 60;

export const DEFAULT_CHANNEL_WEIGHTS: Record<SearchChannel, number> = {
  fulltext: 1.0,
  trigram: 0.6,
  vector: 1.0,
};

export interface ChannelResult {
  channel: SearchChannel;
  /** Ordered best-first. Only the order matters, not the raw scores. */
  ids: readonly string[];
}

export interface FusedResult {
  id: string;
  score: number;
  matchedBy: SearchChannel[];
  /** Best rank achieved in any channel, 1-based. Used for stable tie-breaking. */
  bestRank: number;
}

/**
 * Fuse ranked channel outputs. Deterministic: ties break on best rank, then on id, so the
 * same inputs always produce the same order.
 */
export function fuseByReciprocalRank(
  results: readonly ChannelResult[],
  weights: Record<SearchChannel, number> = DEFAULT_CHANNEL_WEIGHTS,
  k: number = RRF_K,
): FusedResult[] {
  const accumulator = new Map<
    string,
    { score: number; matchedBy: SearchChannel[]; bestRank: number }
  >();

  for (const result of results) {
    const weight = weights[result.channel] ?? 0;
    if (weight === 0) continue;

    result.ids.forEach((id, index) => {
      const rank = index + 1;
      const existing = accumulator.get(id);
      const contribution = weight / (k + rank);
      if (existing === undefined) {
        accumulator.set(id, { score: contribution, matchedBy: [result.channel], bestRank: rank });
      } else {
        existing.score += contribution;
        if (!existing.matchedBy.includes(result.channel)) existing.matchedBy.push(result.channel);
        existing.bestRank = Math.min(existing.bestRank, rank);
      }
    });
  }

  return [...accumulator.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort(
      (a, b) =>
        b.score - a.score || a.bestRank - b.bestRank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

// --- quality weighting -----------------------------------------------------

export interface QualityInput {
  importance: number;
  verificationState: VerificationState;
  state: 'active' | 'stale' | 'archived';
  volatility: 'stable' | 'operational';
  lastVerifiedAt: Date | null;
  now: Date;
}

/** Operational knowledge goes stale faster than architecture or coding style. */
export const FRESHNESS_WINDOW_DAYS = { operational: 14, stable: 180 } as const;

const VERIFICATION_FACTOR: Record<VerificationState, number> = {
  verified: 1.1,
  observed: 1.0,
  inferred: 0.9,
};

/**
 * A deterministic multiplier applied after fusion. It expresses "this entry is more worth
 * trusting", separately from "this entry matched the query better".
 */
export function qualityFactor(input: QualityInput): number {
  const importanceFactor = 0.75 + 0.5 * (Math.min(100, Math.max(0, input.importance)) / 100);
  const verificationFactor = VERIFICATION_FACTOR[input.verificationState];

  let freshnessFactor = 1;
  if (input.state === 'stale') {
    freshnessFactor = 0.6;
  } else if (input.lastVerifiedAt !== null) {
    const ageDays = (input.now.getTime() - input.lastVerifiedAt.getTime()) / 86_400_000;
    if (ageDays > FRESHNESS_WINDOW_DAYS[input.volatility]) freshnessFactor = 0.85;
  }

  return importanceFactor * verificationFactor * freshnessFactor;
}

export interface ScoredCandidate {
  id: string;
  score: number;
  matchedBy: SearchChannel[];
}

export function applyQuality(
  fused: readonly FusedResult[],
  quality: (id: string) => QualityInput | undefined,
): ScoredCandidate[] {
  return fused
    .map((result) => {
      const input = quality(result.id);
      const factor = input === undefined ? 1 : qualityFactor(input);
      return { id: result.id, score: result.score * factor, matchedBy: result.matchedBy };
    })
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- relation expansion ----------------------------------------------------

export interface RelationEdge {
  fromId: string;
  toId: string;
  relation: string;
}

export interface ExpandedHit {
  id: string;
  score: number;
  viaRelation: { fromId: string; relation: string } | null;
}

/** Score multiplier applied per hop away from a directly matched entry. */
export const RELATION_DECAY = 0.5;

/**
 * Expand a result set along relation edges, breadth-first.
 *
 * Cycle protection is a visited set keyed by id: an entry reached twice keeps its first
 * (highest-scoring) provenance, so `a -> b -> a` terminates rather than looping.
 */
export function expandByRelations(
  seeds: readonly ScoredCandidate[],
  edges: readonly RelationEdge[],
  options: { depth: number; maxResults: number },
): ExpandedHit[] {
  const out: ExpandedHit[] = seeds.map((seed) => ({
    id: seed.id,
    score: seed.score,
    viaRelation: null,
  }));
  const visited = new Set(seeds.map((seed) => seed.id));

  if (options.depth <= 0 || edges.length === 0) return out.slice(0, options.maxResults);

  const outgoing = new Map<string, RelationEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.fromId) ?? [];
    list.push(edge);
    outgoing.set(edge.fromId, list);
  }

  let frontier: ExpandedHit[] = out;
  for (let hop = 0; hop < options.depth; hop += 1) {
    const next: ExpandedHit[] = [];
    for (const node of frontier) {
      // Deterministic edge order so expansion output is stable across runs.
      const candidates = [...(outgoing.get(node.id) ?? [])].sort(
        (a, b) => a.relation.localeCompare(b.relation) || a.toId.localeCompare(b.toId),
      );
      for (const edge of candidates) {
        if (visited.has(edge.toId)) continue;
        visited.add(edge.toId);
        next.push({
          id: edge.toId,
          score: node.score * RELATION_DECAY,
          viaRelation: { fromId: node.id, relation: edge.relation },
        });
        if (visited.size >= options.maxResults) break;
      }
      if (visited.size >= options.maxResults) break;
    }
    if (next.length === 0) break;
    out.push(...next);
    frontier = next;
  }

  return out
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, options.maxResults);
}
