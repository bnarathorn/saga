# ADR-0006 — Embedding profiles and a fixed 768-dimension column

- **Status:** accepted
- **Date:** 2026-07-27

## Context

pgvector columns have a fixed dimension. Saga must run without any embedding provider (tests,
air-gapped development) and must degrade rather than fail when Ollama is down.

## Decision

`EmbeddingProvider` is an interface with `name`, `dimensions`, `healthCheck()` and
`embed(texts)`. Two implementations ship:

- `OllamaEmbeddingProvider` — HTTP against `/api/embed`, configurable model and timeout.
- `DeterministicFakeEmbeddingProvider` — a seeded hash expansion (SHA-256 counter mode → float
  in `[-1, 1]`, then L2-normalised). It is deterministic across processes and runs for the same
  input and dimension, which makes vector-search assertions reproducible in CI.

The initial schema fixes `vector(768)`. A profile whose dimension differs from the column is a
**permanent** job failure (`EMBEDDING_DIMENSION_MISMATCH`), never a silent truncation. Changing
the dimension requires a new forward migration plus a re-embed job.

When the provider is unhealthy, embedding jobs retry with backoff, `embedding_state` stays
`queued`/`failed`, and search falls back to full-text + trigram only. Shrine reports `degraded`,
not `unhealthy` (acceptance criterion 20).

## Consequences

- CI needs no model server.
- Vector-search tests assert on the fake provider's stable output.
- Switching to a 1024-dimension model is a migration, which is the intended friction.
