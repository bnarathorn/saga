# ADR-0007 — Heuristic token estimation and deterministic trimming

- **Status:** accepted
- **Date:** 2026-07-27

## Context

Context snapshots are token-budgeted. Saga serves several agent vendors, each with a different
tokenizer, and shipping a real BPE tokenizer would add a large dependency and make snapshot
determinism depend on a vocabulary file version.

## Decision

Use a deterministic heuristic estimator in `@saga/shared`:

```
tokens = ceil(chars / 3.6) + 2 * newlines
```

The divisor is tuned against English technical prose plus fenced code and errs slightly high, so
budgets are conservative. It is pure, dependency-free and identical across processes, which is
what snapshot determinism actually requires (ADR-0005 step 4 flips a pre-built snapshot).

Trimming is deterministic and section-aware. Entries are ordered by
`(section rank, -importance, verification rank, -recency, memory_key)` and dropped from the tail
until the budget fits. Sections carrying warnings and critical operating constraints are never
dropped before lower-value sections — they are ranked first and their per-section reserve is
subtracted from the budget before anything else is allocated.

## Consequences

- Estimates are approximate; budgets are documented as approximate in the API.
- The same Lore versions plus the same configuration always render byte-identical output.
- Swapping in a real tokenizer later means changing one function.
