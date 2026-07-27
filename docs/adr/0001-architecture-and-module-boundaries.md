# ADR-0001 — Architecture and module boundaries

- **Status:** accepted
- **Date:** 2026-07-27

## Context

Saga has four product domains (Lore, Quest, Party, Shrine) plus shared project identity. They
must be separable enough to reason about, but they ship as one deployable API, one worker, and
one PostgreSQL database.

## Decision

A pnpm monorepo with a strict, acyclic dependency direction enforced by TypeScript project
references generated from a single spec (`scripts/scaffold-packages.mjs`):

```
shared → contracts → database → core → shrine → quest → lore
                                            ↘ party
                                  agent-sdk (shared + contracts only)
```

Applications (`apps/server`, `apps/worker`, `apps/cli`, `apps/web`) sit above every domain
package. Domain packages never import from applications.

Each domain package is layered: `domain/` (types + invariants), `repositories/` (raw SQL behind
interfaces), `services/` (transaction boundaries and state transitions), `routes/` (Fastify
plugins) and `jobs/` (worker handlers).

Cross-domain reads go through a service contract, never a direct table read. Where a package
lower in the chain needs data from a package above it — for example Shrine health needing Lore
counts — the higher package registers a **contributor** with the lower one at application
composition time (`HealthRegistry`, `JobHandlerRegistry`, `OutboxDispatcherRegistry`). This keeps
the dependency arrow pointing one way while still letting Shrine present a whole-system view.

## Consequences

- Circular imports are a build error, not a code-review question.
- `apps/server/src/composition.ts` is the single place where domains are wired together, which
  makes the whole system's shape readable in one file.
- Registries add one indirection compared with a direct import.
