# Saga — Testing

Testing is part of implementation here, not a cleanup phase. Every phase of the build was
gated on `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` passing.

---

## Suites

| Command                 | What it covers                    | Needs PostgreSQL |
| ----------------------- | --------------------------------- | :--------------: |
| `pnpm test`             | Unit: pure logic                  |        no        |
| `pnpm test:integration` | Real transactions and concurrency |       yes        |
| `pnpm test:api`         | The full Fastify app              |       yes        |
| `pnpm test:web`         | Guild Hall components in jsdom    |        no        |
| `pnpm test:e2e`         | Playwright browser flows          |       yes        |
| `pnpm test:all`         | Every Vitest project              |       yes        |

Integration and API suites need `SAGA_TEST_DATABASE_URL` pointing at a database you are
willing to have truncated. `testing/global-setup.ts` migrates it once per run; individual
tests truncate rather than re-migrate.

Both run in a **single fork** (`poolOptions.forks.singleFork`): they truncate shared tables
between tests, so two files running at once would wipe each other's fixtures.

Tests always resolve `@saga/*` to TypeScript **source**, never to `dist`, so a stale build can
never mask a regression.

---

## What the tests are actually for

The unit suite covers pure logic where a subtle mistake is invisible in review: project-name
normalization, memory-key validation, the secret policy, reciprocal rank fusion, relation
expansion and cycle protection, token-budget trimming, snapshot determinism, activation
classification, parent-state projection, the claim-policy matrix, overlap ranking, lease
arithmetic, retry backoff and sanitized configuration.

The integration suite exists for the claims that can only be true against a real database:

- Two checkpoints at the same expected revision → exactly one succeeds, one 409s.
- Two exclusive claims on one resource → exactly one wins.
- Shared claims coexist where policy permits.
- Lore updates touching _different_ entries publish concurrently.
- Lore updates touching the _same_ entry conflict, and the loser is durably recorded.
- A partial conflict changes **no** pointer — not even the entries that would have succeeded.
- A context snapshot activates atomically with publication; a failed publish leaves it alone.
- A stale job claim is recovered, and the late worker cannot complete it.
- An expired agent run expires its claims while the Quest and checkpoints survive.
- Outbox events commit atomically with their domain mutation, and _only_ with it.
- Enqueuing a deduplicated job does not abort the caller's transaction.
- Project rename preserves the UUID; the old alias resolves; collisions are rejected.
- The schema contains no repository, source or branch identity table or column.

The API suite drives the real Fastify app: authentication, CSRF, the authorization matrix,
project lifecycle, the whole Lore pipeline, the two-phase session flow, Party coordination,
Shrine operations, idempotency replay and mismatch, and the security requirements.

The web suite asserts the states that are easy to skip: loading, empty, degraded and error;
permission-based action visibility, so a hidden control is also a refused one; the event
stream degrading to polling and saying so; keyboard reachability of the primary flows; and
that mutations carry the CSRF header.

---

## Browser tests

`pnpm test:e2e` runs the section-21.4 scenario end to end — administrator login, project
creation, the Lore bootstrap state, proposing and publishing an Entry, an agent session and
checkpoint, the Quest Board and its handoff, Party liveness, and retrying a failed job from
Shrine with the reason landing in the audit log.

The stack is hermetic and disposable:

- its own ports (API 4419, Guild Hall 4420), so it cannot collide with `scripts/stack.sh`;
- `tests/e2e/prepare.ts` migrates and truncates the test database as the first half of the API
  `webServer` command, because the bootstrap administrator is only created when no user
  exists — a database left over from Vitest would leave the browser with no credentials;
- the worker is started by `tests/e2e/global-setup.ts`, since a Playwright `webServer` entry
  is identified by a URL and the worker listens on none;
- `SAGA_EMBEDDING_PROVIDER=fake`, so no network call is involved.

The project is switched to `lore_approval_mode = manual` before step 4. Under the default
`auto` mode the worker publishes as soon as validation passes, and there is nothing left for a
human to approve in the browser.

---

## Live verification

Two scripts run against a _running_ stack, so they catch wiring that unit-level mocking would
hide:

```bash
scripts/stack.sh up
pnpm exec tsx scripts/verify.ts   # 75 assertions across every slice
pnpm demo                          # the full section-25 demonstration
```

`scripts/demo.ts` drives the **real MCP tool handlers** from a temporary plain folder with no
version control — the same code path an agent takes through `saga mcp`. It found a real defect
that no unit test would have: Quest embedding jobs whose payload the handler could not parse.

`pnpm demo` builds `packages/agent-sdk` first, for the same reason the OpenAPI scripts build
`packages/contracts`. The handlers themselves are imported by relative path and so always come
from source, but they import `@saga/agent-sdk` and `@saga/shared`, which resolve to `dist` —
so without the build the demo exercises current handlers against a previously-built SDK, which
is the layer the coverage suites found real defects in.

---

## Continuous integration

`.github/workflows/ci.yml` runs every suite on push to `main` and on every pull request, in
this order: `lint`, `typecheck`, `openapi:check`, `test`, `test:web`, `build`,
`test:integration`, `test:api`, `test:e2e` — every suite, each as its own step rather than a
single `test:all`, because the integration and api projects truncate shared tables and must
not run concurrently. The OpenAPI step is what spec 22.3 requires — generated artifacts must
never drift from the Zod contracts they come from.

Both `openapi:generate` and `openapi:check` run `tsc -b packages/contracts` first, and that build
is load-bearing rather than tidiness. Every `@saga/*` package exports only `./dist`, and there is
no `paths` mapping, so `tsx scripts/generate-openapi.ts` resolves the contracts — and, through
them, `ERROR_CODES` from `@saga/shared` — to compiled output. Without the build the generator
renders the _previous_ build's schemas: removing an error code from `src` and regenerating once
produced no diff at all, and `--check` then compared two equally stale artifacts and reported
success. A guard that cannot fail is worse than no guard, so the build stays in the command.
`tsc -b` is incremental, and CI has already built everything by the typecheck step, so it costs
about a second there.

PostgreSQL comes from a `pgvector/pgvector:pg16` service container. Two databases are created,
not one:

| Database    | Used by                        | Why separate                                                                                                              |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `saga_test` | `test:integration`, `test:api` | Suites truncate between tests but keep the schema.                                                                        |
| `saga_e2e`  | `test:e2e`                     | The browser stack _empties_ its database before the API starts, so sharing would wipe the other suites' fixtures mid-run. |

CI sets only `SAGA_TEST_DATABASE_URL` and `SAGA_E2E_DATABASE_URL`. Everything else has a
default: `testing/harness.ts` supplies its own config, and `tests/e2e/stack-env.ts` supplies
the e2e stack's. `.env` is not committed, and `loadDotEnv` tolerates its absence with the
process environment always winning — so a test that only passes because of a local `.env` will
fail in CI. To reproduce that condition locally:

```bash
mv .env .env.local-backup
SAGA_TEST_DATABASE_URL=postgres://saga:saga@127.0.0.1:5432/saga_test \
SAGA_E2E_DATABASE_URL=postgres://saga:saga@127.0.0.1:5432/saga_e2e \
  pnpm lint && pnpm typecheck && pnpm openapi:check && pnpm test && pnpm build \
  && pnpm test:integration && pnpm test:api && pnpm test:e2e
mv .env.local-backup .env
```

Only Chromium is installed: the Playwright config pins a single project, so the other engines
are download and cache weight for nothing. On failure the report and traces upload as an
artifact.

---

## Writing tests here

- Assert the _behaviour the specification promises_, not the implementation.
- Name the acceptance criterion in a comment when a test defends one.
- For concurrency, use `Promise.allSettled` and assert the winner/loser split — not just that
  no error was thrown.
- Prefer a real database over a mock for anything involving a transaction, a lock or an index.
- When a test fails, first ask whether the test or the code is wrong. Several defects in this
  codebase were found because a test that _looked_ wrong was right.
