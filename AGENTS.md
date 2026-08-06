# AGENTS.md

Orientation for an agent or a new contributor working on Saga itself. `README.md` explains how to
run Saga; `docs/` explains how it behaves; this file records what a newcomer would otherwise have
to rediscover — the invariants that must not be broken, the questions already settled, and the
traps that have cost someone a day.

It replaces the three root documents that used to carry this material: `HANDOFF.md`, the
phase-by-phase `IMPLEMENTATION_PLAN.md`, and the 4,000-line specification prompt the project was
built from. What was durable in them is below; what was scaffolding is in the git history.

---

## 1. What Saga is

Shared project memory, work continuity and coordination for coding agents. A new session should
never rediscover a project from zero: Saga holds what the project _is_, what was done, what is in
progress, what is blocked, and who else is working right now.

| Domain     | Owns                                                          |
| ---------- | ------------------------------------------------------------- |
| **Lore**   | Durable project knowledge, versioned and published atomically |
| **Quest**  | Work items, sessions, checkpoints, handoffs                   |
| **Party**  | Live agent coordination — everything leased, nothing durable  |
| **Shrine** | Server health, jobs, events, configuration, audit             |

The web console is **Guild Hall**. Agents reach Saga over MCP or the typed `@saga/agent-sdk`.

---

## 2. Layout and dependency direction

```text
apps/       server (Fastify) · worker · web (Guild Hall) · cli (`saga` + MCP server)
packages/   shared · contracts · database · core · shrine · quest · lore · party · agent-sdk
db/         forward-only migrations 0001–0007, seeds
deploy/     Docker, nginx, systemd, saga-tools
docs/       architecture · api · agent-integration · operations · security · testing · adr/
scripts/    dev, stack, verify, demo, openapi generation, package scaffolding
```

Dependency direction is enforced by TypeScript project references generated from a single spec
(`scripts/scaffold-packages.mjs`), so a cycle is a build error rather than a review comment. A
lower layer never reads a higher one; the two sanctioned exceptions are documented in
`docs/architecture.md` §2 with their reasons.

`apps/web` may not import runtime values from a package barrel — that pulls Zod into the browser
bundle. `eslint.config.js` enforces it. Types are fine.

---

## 3. Commands

| Command                                 | What it does                                        |
| --------------------------------------- | --------------------------------------------------- |
| `pnpm dev`                              | API, worker and Guild Hall together                 |
| `pnpm build` / `lint` / `typecheck`     | The gate every change must pass                     |
| `pnpm test`                             | Unit — no external services                         |
| `pnpm test:integration` / `:api`        | Against real PostgreSQL                             |
| `pnpm test:web` / `:e2e`                | Component tests / Playwright                        |
| `pnpm openapi:check`                    | Fails if `docs/openapi.json` is stale               |
| `pnpm db:migrate` / `:status` / `:seed` | Schema management (`db:reset` is dev and test only) |
| `scripts/stack.sh up`                   | Background API + worker                             |
| `pnpm exec tsx scripts/verify.ts`       | 75 assertions against a live stack                  |
| `pnpm demo`                             | The full agent flow through the real MCP handlers   |

Integration, API and e2e tests need `SAGA_TEST_DATABASE_URL` pointing at a database you are willing
to have truncated.

---

## 4. Design commitments

Product shape, not implementation detail. Changing one of these is a product decision.

- **A project is identified by its name**, never by a repository URL, branch or commit. Renaming
  preserves identity and keeps the old name resolvable as an alias.
- **The server never depends on version control.** A plain folder, a Git working copy with no
  remote, and an SVN working copy all behave identically.
- **A Lore Entry is a unit of knowledge, not a document chunk.** Saga is not a document store.
- **Durable state and live coordination are separate.** Lore and Quest survive crashes; Party is
  leased and expires safely.
- **A new session never inherits an unrelated handoff.** Startup is two-phase: core context first,
  then the first task classifies as `new_work`, `resume_work` or `inquiry`.
- **Coordination is optional.** `PARTY_MODE=off` leaves Lore and Quest fully usable.
- **A Quest closes because someone said so, never because Saga inferred it.** An agent declares
  the outcome with `quest_status` on its final handoff; the project's `quest_completion_mode`
  decides whether that lands or waits for Guild Hall. Nothing reads the work state and concludes
  the job is done — `completed` is outside `RESUMABLE` and no tool can reopen it, so a wrong
  close silently forks the work.
- **Saga is not source control or a deployment platform.** External systems stay authoritative for
  code, databases and deployments.

Load-bearing technical assumptions, each with an ADR in `docs/adr/`: vector dimension fixed at 768
(0006); the transactional outbox is delivered by the worker, not `LISTEN/NOTIFY` (0004); web
sessions are opaque server-side rows in an `HttpOnly` cookie, not JWTs (0003); raw SQL behind
repository interfaces, no ORM (0002); token counting is a deterministic heuristic, not a model
tokenizer (0007).

---

## 5. State

Phases 0–6 are delivered: foundation and Shrine, Lore, Quest, CLI and MCP, Party, then hardening.
Schema version 7. Every phase landed with its suites green, and each found real defects worth
knowing about — a `conflict` write inside a transaction that then rolled back, unspecified
`RETURNING` row order in the job-claim CTE, a dedupe unique-violation caught in JavaScript that had
already aborted the PostgreSQL transaction (now `ON CONFLICT DO NOTHING`), and an `embedding` job
enqueued with a payload its handler did not accept. All fixed with regression tests; the commit
messages carry the full rationale.

Measured 2026-08-06, not copied forward — re-measure rather than trust this table.

| Suite                                | Count                      |
| ------------------------------------ | -------------------------- |
| `pnpm lint` / `typecheck`            | clean                      |
| `pnpm openapi:check`                 | up to date (73 paths)      |
| unit / integration / api / web / e2e | 488 / 136 / 152 / 139 / 8  |
| `scripts/verify.ts`                  | 75/75 against a live stack |

---

## 6. Settled — do not re-derive

### Refuted findings; the code is right as it stands

1. **"SSE keeps `app.close()` hanging for the full shutdown timeout."** Measured: with
   `sse.clients: 1` and a live `curl -N` attached, SIGTERM shutdown took **7 ms** with and without
   the proposed fix, and no timeout was logged. The `preClose` handler in
   `apps/server/src/routes/events.ts` was kept because ending streams explicitly is tidier than
   dropping sockets and lets clients reconnect — but it is a courtesy, not a fix. Do not describe
   it as one.
2. **"`event_projection` needs the partial-index predicate in `listUnprojected` to be
   index-usable."** Postgres hash-joins that anti-join regardless of the expression index, and the
   job is a rare bounded repair over a retention-capped table. Changing it would be noise.
3. **"`constants.ts` carries five unused lists."** They were exported from `@saga/contracts` before
   being relocated; the public API is byte-identical.

### Decided, not deferred

- **`saga connect` cannot offer project selection.** The project is chosen by the _approver_ in
  Guild Hall's `/device` page, and `/api/auth/device/approve` mints the token bound to it. Bearer
  auth resolves agent tokens only, so the CLI can never list projects. `--project` therefore
  **asserts**: it fails before touching disk when the token is bound elsewhere.
- **Cross-project access answers 404, not 403** (`apps/server/src/lib/project-access.ts`). A 403
  would confirm the other project exists. The second implementation that answered 403 was deleted,
  and `PROJECT_SCOPE_MISMATCH` removed from the error contract with it.
- **The workspace-key hash separates fields with a NUL**, written `\0` so the file is not binary to
  git. Do not "tidy" it to a space — that silently changes every existing `workspaceKey`.
- **Compose defaults `NODE_ENV` to production**, not development. `.env.example` sets `development`
  explicitly so the quickstart works; the default only applies when the key is absent, and there
  refusing to start beats running unguarded.
- **Automatic resume almost never fires on wording alone, and that is intended.**
  `AUTO_RESUME_THRESHOLD` is 0.6 (`packages/quest/src/domain/activation.ts`) and scoring is blunt —
  title-word overlap, recency, status. Against the Quest "Add CSV report export",
  `"continue the CSV export work"` scores **0.35**; even `"Continue the CSV report export work"`
  scores **0.45**. Both classify as `new_work`. The vector-similarity term never contributes
  through HTTP: `apps/server/src/routes/quest.ts` calls `sessions.activate()` with no `similarity`
  argument. Uncertainty is answered with new work by design. `scripts/demo.ts` resumes by passing
  `requested_quest_id`, which short-circuits scoring. Know this before "fixing" a resume that looks
  broken.

---

## 7. Traps

- **Anything run through `tsx` reads `dist`, not `src`.** Every `@saga/*` package exports only
  `./dist` and there is no `paths` mapping, so a workspace import resolves to compiled output. This
  once let `openapi:generate` certify the spec against the previous build's enum. Every `tsx` entry
  point now builds its narrowest covering project first — `openapi:*` builds `packages/contracts`;
  `demo` and `saga` build `packages/agent-sdk`; the `db:*` scripts build `packages/database`;
  `scripts/stack.sh up` and `pnpm dev` build `apps/server apps/worker`. Roughly 300–500 ms each,
  accepted deliberately: running the previous build silently is worse than waiting half a second.
  If you add another `tsx` entry point, build its graph. Only `scripts/verify.ts` is exempt,
  because it drives a running server over HTTP.

  A tsconfig `paths` alias was evaluated as the alternative. **Reject it.** `tsx` honours `paths`,
  but a single pattern silently _mixes_ resolution: bare `@saga/shared` resolves to source while
  `@saga/shared/dotenv` falls back to `dist`, with no error. `vitest.shared.ts` needs two patterns
  for exactly this reason. Half-fresh imports are harder to diagnose than uniformly stale ones.

- **Beware vacuous tests.** A first-draft OpenAPI guard used a non-existent `app.routes` with
  `?? []` and would have passed while checking nothing. An integration test for the login-redirect
  guard passed with the guard reverted, because `MemoryRouter` never calls the real
  `history.pushState` — it is asserted directly in `Login.test.tsx` instead. When you write a guard
  test, break the thing and watch it fail.

- **Check that a fix reaches the real caller.** Wrapping the job-retry route in `withIdempotency`
  looked like it fixed a double-clicked Retry. It did not: Guild Hall sends no `Idempotency-Key`.
  The actual fix was disabling the button while in flight, and `/device`'s approve button uses the
  same pattern.

- **`scripts/stack.sh up` gates only on `/health/live`.** Run it right after `pnpm test:e2e` and the
  dying Playwright `webServer` can answer that probe from port 4319, so the script reports the stack
  up moments before the real API binds. Run `scripts/stack.sh down` first.

- **`pnpm dev` and orphaned children.** `dev.mjs` used to signal each direct child, which is `pnpm`
  — and `pnpm` does not forward to the `sh -c tsx watch …` grandchild holding the port. Children are
  now `detached` and shut down with `process.kill(-pid)`. If you test this, signal
  `node scripts/dev.mjs` specifically: `pgrep -f scripts/dev.mjs` also matches the `sh -c` wrapper
  pnpm puts in front of it, and killing that wrapper skips the handler entirely — which makes a
  working shutdown look broken.

- **`.dockerignore` is load-bearing, and it tracks `.gitignore`.** Both Dockerfiles `COPY . .`,
  and the runtime stage copies `/app/apps` and `/app/packages` wholesale. Without the ignore file
  the developer's own `dist/` rode along — and since Docker preserves mtimes, `tsc -b` then found
  every project up to date and compiled nothing, so the image shipped whatever the host had built
  from whatever branch it was on. `node_modules` was the other 240 MB of a 256 MB context, and it
  overwrote the `deps` stage's lockfile install. Every path excluded is also in `.gitignore`,
  which is what keeps `git status` inside the build stage clean — and that is what keeps the CLI
  from stamping itself `.dirty`. If you exclude a _tracked_ path, every image build is dirty.

- **The build stage installs git on purpose.** `node:22-bookworm-slim` has none, so
  `bundle.mjs`'s `git rev-parse` failed silently and every Compose image served
  `0.1.0+local.<wall clock>`: a version naming no commit, differing on every rebuild of an
  unchanged tree — so every agent host was told an update was available for a build that changed
  nothing — and not the `0.1.0+g<sha>` that README step 6 tells the user to look for. `.git`
  therefore stays _in_ the context. `SAGA_CLI_BUILD_ID` is plumbed through as a Compose build arg
  for a release process that names its own builds.

- **Verify before acting.** Roughly a fifth of reported findings do not survive checking. The
  fastest discriminators are running the function, `EXPLAIN`, and measuring.

---

## 8. Deployment

`deploy/` carries two shapes: Docker Compose, and an nginx + systemd reference deployment for a
single host. There is exactly one way to update the latter, and `deploy/saga-tools` is it.

Installed as `/usr/local/bin/saga-tools`: `status` reports the deployed commit, whether the remote
is ahead and which CLI build is being served; `update` fetches the published branch straight into
`/opt/saga` — the repository is public, so no credential is involved — fast-forwards, then builds
with `HOME` outside the checkout (the service account's home may _be_ the deploy directory),
republishes the web bundle, restarts migrations before the API and worker, and polls until the
served CLI reports the commit just deployed. `rebuild` is that second half alone, for a rollback
or an interrupted build; it reaches the network only to verify. `update` refuses a
non-fast-forward rather than resolving it, naming the `reset --hard` that would deliberately
discard the deployed commit.

There used to be a second script, `deploy/update.sh`, which moved a commit from a developer
checkout as a git bundle. It was written when the repository was private and the service account
could not fetch; that has not been true since `b62a16c`, and `saga-tools` had been calling it for
the build half anyway. Removed — a commit reaches production by being on the published branch.
Its history is at `298cffa` if the bundle mechanism is ever wanted back.

A CLI build is identified by a SHA-256 of its bytes (`x-saga-cli-build`), not by its version:
every pre-1.0 build would otherwise stamp `0.1.0` and `saga update` could never tell two apart.
Builds stamp themselves `0.1.0+g<shortsha>.<UTC timestamp>`, and a clean tree uses the commit's own
time so the same commit rebuilds byte-identical.

---

## 9. Known limitations

Known rather than discovered, and none of them defects.

1. **The demonstration is not guarded by CI.** `scripts/verify.ts` and `pnpm demo` need a live
   stack, which the workflow does not start. Playwright covers the same ground through the browser.
2. **`CREATE INDEX CONCURRENTLY` is unexercised at scale.** Migration 0006 is correct by
   construction and the benefit was measured at 50k rows, but the concurrent build has only run
   against small tables.
3. **The health monitor assumes one API process.** Two instances transitioning simultaneously can
   both record the change; the duplicate row is cosmetic.
4. **`latency.lore_publish` counts approvals only.** Under `auto` approval the publish transaction
   runs inside the worker's `memory_validation` job, so its cost is reported there.
5. **In-process metrics are per instance and reset on restart.** Everything read from PostgreSQL is
   cluster-wide and survives.
6. **Single-node reference deployment.** Horizontal scaling is not designed for beyond what leasing
   already permits.
7. **The Docker path is built by CI but still not booted end to end.** The `image` job in
   `.github/workflows/ci.yml` builds both images on every push and asserts two things about what
   comes out: that the CLI it serves names the commit it was built from, and that `.env` never
   reaches the build stage. What no job does is _run_ the stack — no `docker compose up`, no
   request against it. Environment interpolation is still verified only by simulating
   `${VAR:-default}` and feeding the result to `loadConfig()`. Worth one real
   `docker compose up -d --build` on a machine that has the Compose plugin.
8. Smaller open items: `Layout.test.tsx` builds its own route tree, overlapping `App.test.tsx`; the
   advisory locks and the atomic config write have no concurrency test; `saga doctor` has no
   keychain-backend test; the `/device` project picker requests `limit=200` with no paging.

---

## 10. The documentation site is not in this repository

It is maintained separately as plain HTML (English with a Thai mirror), and it is **not** generated
from `docs/`. Measured: only 3.1% of the site's 8-word sequences appear anywhere in `docs/*.md` or
`README.md`, and the page sets do not correspond — several pages have no source file, and
`api.md`, `security.md`, `testing.md` and `agent-integration.md` have no page. Generating it from
`docs/` would delete most of it and invent the rest. Do not propose that.

What actually drifts is not the prose, which describes design intent and stays true, but the
extractable facts in tables and `<pre>` blocks: commands, environment defaults, endpoints,
identifiers, counts. The precedent for guarding those already exists here —
`packages/core/src/security/authorization-docs.test.ts` parses a markdown table and diffs it
against `ROLE_PERMISSIONS`. Applying that to the site requires the site under version control
first, which is the real prerequisite.

---

## 11. Where to read next

| Document                                                 | Covers                                           |
| -------------------------------------------------------- | ------------------------------------------------ |
| [`README.md`](README.md)                                 | Install, run, verify, connect an agent           |
| [`docs/architecture.md`](docs/architecture.md)           | Domains, state ownership, boundaries, invariants |
| [`docs/api.md`](docs/api.md)                             | Endpoints, error codes, pagination, idempotency  |
| [`docs/agent-integration.md`](docs/agent-integration.md) | MCP setup, session policy, tools, checkpoints    |
| [`docs/operations.md`](docs/operations.md)               | Deployment, upgrades, backups, troubleshooting   |
| [`docs/security.md`](docs/security.md)                   | Authentication, scopes, secrets, audit           |
| [`docs/testing.md`](docs/testing.md)                     | Suites, what they are for, how to run them       |
| [`docs/adr/`](docs/adr/)                                 | The eight architecture decision records          |
