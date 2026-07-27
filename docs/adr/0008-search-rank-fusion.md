# ADR-0008 — Reciprocal rank fusion for Lore search

- **Status:** accepted
- **Date:** 2026-07-27

## Context

Lore search combines PostgreSQL full-text ranking, trigram similarity and pgvector cosine
distance. These produce scores on incomparable scales (`ts_rank_cd` is unbounded, `similarity`
is `[0,1]`, cosine distance is `[0,2]`), so a weighted sum of raw scores is not stable and is
hard to test.

## Decision

Fuse by **rank**, not by score, using reciprocal rank fusion:

```
score(d) = Σ_r  w_r / (k + rank_r(d))          k = 60
```

with default channel weights `fulltext 1.0`, `trigram 0.6`, `vector 1.0`. Each channel
contributes only documents it actually returned; a channel that is unavailable (no embedding
provider) simply contributes nothing, so search degrades instead of failing.

The fused score is then multiplied by a deterministic quality factor:

```
quality = importanceFactor · verificationFactor · freshnessFactor
importanceFactor    = 0.75 + 0.5 · (importance / 100)
verificationFactor  = verified 1.10 | observed 1.00 | inferred 0.90
freshnessFactor     = stale 0.60 | operational older than its window 0.85 | else 1.00
```

Ties break on `memory_key` ascending so results are stable across runs.

Relation expansion runs after fusion: one hop by default (`relation_depth`, max 2), with a
visited set for cycle protection and a hard cap on total results. Expanded entries are marked
`via_relation` and scored at 0.5× the score of the entry that pulled them in.

## Consequences

- Adding a channel does not require rebalancing existing weights.
- `fuseByReciprocalRank` is a pure function with direct unit tests.
- Rank fusion cannot express "this full-text hit was overwhelmingly better"; the quality factor
  is the intentional escape hatch.
