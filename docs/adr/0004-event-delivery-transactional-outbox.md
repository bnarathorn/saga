# ADR-0004 — Transactional outbox, polled by the worker

- **Status:** accepted
- **Date:** 2026-07-27

## Context

Domain mutations must produce events (`quest.checkpoint_created`, `party.claim_acquired`, …)
that reach SSE subscribers and projections without a distributed transaction, and without
losing events when the API process dies mid-request.

## Decision

`core.outbox_events` rows are inserted in the same transaction as the mutation that produced
them. A worker handler (`outbox_delivery`) claims pending rows with
`FOR UPDATE SKIP LOCKED`, dispatches them to registered handlers, and marks them `published`.
Delivery is at-least-once; every dispatcher must be idempotent.

`LISTEN`/`NOTIFY` is deliberately **not** the transport. It gives no durability across a
subscriber restart and no replay, and Saga needs `Last-Event-ID` resume for SSE.

Dispatch fan-out for the SSE stream goes through `shrine.system_events`, which carries a
monotonic `bigint` sequence used as the SSE event ID. A reconnecting browser sends
`Last-Event-ID` and receives everything after that sequence.

## Consequences

- Event visibility lags the mutation by up to one worker poll interval (default 1 s).
- Nothing is lost if the API crashes after commit.
- The outbox table needs retention (`retention_cleanup` job).
