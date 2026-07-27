# ADR-0002 — Raw SQL behind repository interfaces, no ORM

- **Status:** accepted
- **Date:** 2026-07-27

## Context

Saga's correctness rests on things ORMs typically abstract away: `SELECT ... FOR UPDATE`,
`SKIP LOCKED`, advisory locks, deterministic multi-row lock ordering, compare-and-swap updates,
and a transactional outbox written in the same transaction as its domain mutation.

## Decision

Use `pg` (node-postgres) directly. Every query lives in a repository class that takes an explicit
`Queryable` (either the pool or an active transaction client) as its first constructor argument
or method argument. Transactions are opened only in service methods via
`withTransaction(pool, fn)`, which is the only place `BEGIN`/`COMMIT`/`ROLLBACK` appear.

Repositories are interfaces in the domain package; the PostgreSQL implementation is a sibling
class. Route handlers never see a `Pool`.

Vector values are serialised as pgvector's `'[1,2,3]'` text literal and cast with `::vector`,
because `pg` has no native binary codec for the type.

## Consequences

- Concurrency behaviour is visible in the SQL, and integration tests assert it directly.
- More hand-written mapping code. Mitigated by a small `rowMappers` helper per repository and by
  Zod-validating everything crossing the API boundary.
- Schema drift is caught by integration tests rather than by generated types.
