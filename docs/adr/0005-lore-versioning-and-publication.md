# ADR-0005 — Immutable Lore versions with item-level compare-and-swap

- **Status:** accepted
- **Date:** 2026-07-27

## Context

Two agents may propose Lore changes at the same time. Using
`core.projects.memory_revision` as the only concurrency gate would make every concurrent
proposal conflict, even when they touch unrelated knowledge — the prompt forbids this
explicitly.

## Decision

`lore.memory_items` holds identity plus a `current_version_id` pointer. `lore.memory_versions`
rows are immutable after insert, except for worker-owned embedding fields and `ready_at`.

A proposal is a `lore.memory_updates` row plus one `lore.memory_update_items` row per affected
item, each carrying the `base_version_id` the proposer observed. Publication:

1. `SELECT ... FOR UPDATE` all affected `memory_items`, **ordered by id** (deterministic lock
   order, no deadlocks between concurrent publishes).
2. Compare each item's `current_version_id` with the update item's `base_version_id`.
3. Any mismatch → change no pointers, mark the update `conflict`, return HTTP 409.
4. Otherwise repoint every item, bump `memory_revision` once, activate the prepared context
   snapshot, mark the update `published`, insert the outbox event, commit.

`memory_revision` is therefore an observability and cache-busting counter, never the conflict
gate.

## Consequences

- Updates touching disjoint entries publish concurrently (acceptance criterion 6).
- Updates touching the same entry from the same base produce exactly one winner (criterion 7).
- A snapshot must be built *before* publication so the pointer flip stays inside one short
  transaction (criterion 8).
