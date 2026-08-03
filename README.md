# Saga

> **No agent starts at level one.**

Saga is a shared project-memory, work-continuity and coordination system for Codex, Claude and
other coding agents. A new agent session should never have to rediscover a project from zero:
Saga remembers what the project _is_, what was already done, what is in progress, what is
blocked, and who else is working right now.

```text
Saga
├── Lore     Project knowledge and persistent memory
├── Quest    Work continuity: sessions, checkpoints and handoffs
├── Party    Agents and live coordination
└── Shrine   Server health, workers, jobs, alerts and operations
```

The web console is called **Guild Hall**.

---

## Quick start

Requirements: **Node.js 22+**, **pnpm 9+**, and **PostgreSQL 15+ with `pgvector`, `pg_trgm`
and `pgcrypto`** (or Docker, which brings its own). Compose v2 is a separate CLI plugin, and
Docker packaged by an older distribution often arrives without it — check with
`docker compose version`, not `docker --version`.

The repository is private: run `gh auth login`, or use a token with the `repo` scope, or the
clone fails on `could not read Username for 'https://github.com'`.

### With Docker

```bash
git clone https://github.com/bnarathorn/saga.git saga && cd saga
cp .env.example .env
# .env.example already ships a working (development-only) session secret and an empty
# bootstrap password, so replace those two lines in place rather than appending — the
# loader Saga's own processes use resolves duplicate keys first-wins, opposite of Docker
# Compose, so an appended line would only take effect for one of the two:
sed -i "s|^SAGA_SESSION_SECRET=.*|SAGA_SESSION_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^SAGA_BOOTSTRAP_ADMIN_PASSWORD=.*|SAGA_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 12)|" .env
# .env.example points SAGA_PUBLIC_URL at the Vite dev-server port; under Compose, Guild
# Hall is served by nginx on 8080, so that line needs to move too:
sed -i "s|^SAGA_PUBLIC_URL=.*|SAGA_PUBLIC_URL=http://localhost:8080|" .env

docker compose up -d --build
```

Guild Hall is then on <http://localhost:8080>. Sign in with the bootstrap administrator you
just generated (`grep SAGA_BOOTSTRAP .env`).

### Without Docker

```bash
git clone https://github.com/bnarathorn/saga.git saga && cd saga
pnpm install
cp .env.example .env      # then set SAGA_BOOTSTRAP_ADMIN_PASSWORD

# One-time database setup (adjust the role/password to taste):
sudo -u postgres psql -c "CREATE ROLE saga LOGIN PASSWORD 'saga' SUPERUSER"
sudo -u postgres createdb -O saga saga_dev
sudo -u postgres createdb -O saga saga_test
for db in saga_dev saga_test; do
  sudo -u postgres psql -d $db -c \
    "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
done

pnpm db:migrate
pnpm dev            # API + worker + Guild Hall dev server
```

| Service    | URL                     |
| ---------- | ----------------------- |
| Guild Hall | <http://localhost:4320> |
| Saga API   | <http://localhost:4319> |

`SUPERUSER` is only needed to `CREATE EXTENSION` on first run; you can drop the attribute
afterwards.

---

## Verifying the installation

With the stack running:

```bash
scripts/stack.sh up      # background API + worker (skip if `pnpm dev` is already running)
pnpm exec tsx scripts/verify.ts
```

`scripts/verify.ts` drives the real HTTP API against real PostgreSQL with the real worker,
and asserts the behaviour the specification calls for — project renaming and alias
resolution, idempotency replay, the job queue draining, operator retry with an audit record,
sanitized configuration, and project-scoped agent tokens being unable to reach another
project.

---

## Connecting an agent

The `saga` command is not published to any registry — it is the workspace package
`apps/cli`, whose `bin` entry points at a compiled `dist/main.js`, not at the TypeScript
source. Build it once and link it onto your `PATH`:

```bash
pnpm --filter @saga/cli build
pnpm -C apps/cli link --global
```

If pnpm reports `ERR_PNPM_NO_GLOBAL_BIN_DIR`, it has no global bin directory configured yet;
run `pnpm setup` once, open a new shell so the change takes effect, and repeat the `link`
command above.

`saga --version` should now work from any directory. From inside the project you want Saga to
manage — not from the Saga repository itself — run `saga connect`; see
[`docs/agent-integration.md`](docs/agent-integration.md) for the rest of the flow.

---

## Repository layout

```text
saga/
├── apps/
│   ├── server/     Fastify API
│   ├── worker/     background worker (jobs, outbox delivery, retention)
│   ├── web/        Guild Hall (React + Vite)
│   └── cli/        the `saga` command line interface and MCP server
├── packages/
│   ├── shared/     errors, config, logging, time, redaction, token budgeting
│   ├── contracts/  Zod request/response contracts shared by API, web and CLI
│   ├── database/   pg pool, explicit transactions, advisory locks, migration runner
│   ├── core/       project identity, aliases, outbox, security
│   ├── shrine/     jobs, service instances, events, health
│   ├── quest/      work items, sessions, checkpoints
│   ├── lore/       durable project knowledge
│   ├── party/      live agent coordination
│   └── agent-sdk/  typed client for non-MCP integrations
├── db/migrations/  forward-only Saga schema migrations
├── deploy/         Docker, nginx and systemd reference deployment
└── docs/           architecture, API, operations, security, testing, ADRs
```

Dependency direction is enforced by TypeScript project references generated from a single
spec (`scripts/scaffold-packages.mjs`), so a cycle is a build error rather than a review
comment.

---

## Commands

| Command                 | What it does                                                 |
| ----------------------- | ------------------------------------------------------------ |
| `pnpm dev`              | API, worker and Guild Hall dev server together               |
| `pnpm build`            | Compile every package and build Guild Hall                   |
| `pnpm lint`             | ESLint across the workspace                                  |
| `pnpm typecheck`        | `tsc -b` plus the web project                                |
| `pnpm test`             | Unit tests (no external services required)                   |
| `pnpm test:integration` | PostgreSQL integration tests, including real concurrency     |
| `pnpm test:api`         | Full Fastify app against PostgreSQL                          |
| `pnpm test:web`         | Guild Hall component tests                                   |
| `pnpm test:all`         | Every Vitest project                                         |
| `pnpm test:e2e`         | Playwright browser tests                                     |
| `pnpm db:migrate`       | Apply pending migrations                                     |
| `pnpm db:status`        | Show current and expected schema versions                    |
| `pnpm db:seed`          | Load development seed data                                   |
| `pnpm db:reset`         | Drop and re-apply the schema (**development and test only**) |

Integration, API and end-to-end tests need `SAGA_TEST_DATABASE_URL` to point at a database
you are willing to have truncated.

---

## Documentation

| Document                                                 | Covers                                          |
| -------------------------------------------------------- | ----------------------------------------------- |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)       | Phase-by-phase status                           |
| [`docs/architecture.md`](docs/architecture.md)           | Domains, state ownership, boundaries            |
| [`docs/api.md`](docs/api.md)                             | Endpoints, error codes, pagination, idempotency |
| [`docs/agent-integration.md`](docs/agent-integration.md) | MCP setup for Codex and Claude, session policy  |
| [`docs/operations.md`](docs/operations.md)               | Deployment, upgrades, backups, troubleshooting  |
| [`docs/security.md`](docs/security.md)                   | Authentication, token scopes, threat notes      |
| [`docs/testing.md`](docs/testing.md)                     | Test strategy and how to run each suite         |
| [`docs/adr/`](docs/adr/)                                 | Architecture decision records                   |

---

## Design commitments

These are not implementation details; they are the shape of the product.

- **A project is identified by its name**, never by a repository URL, branch or commit.
  Renaming preserves identity and keeps the old name resolvable as an alias.
- **The server never depends on version control.** A plain folder, a Git working copy with no
  remote, and an SVN working copy all work identically.
- **A Lore Entry is a unit of knowledge, not a document chunk.** Saga is not a document store.
- **Durable state and live coordination are separate.** Lore and Quest survive crashes; Party
  is leased and expires safely.
- **A new session never inherits an unrelated handoff.** Session startup is two-phase: core
  context first, then the first task decides `new_work`, `resume_work` or `inquiry`.
- **Coordination is optional.** `PARTY_MODE=off` leaves Lore and Quest fully usable.
- **Saga is not source control or a deployment platform.** It records knowledge, intent and
  progress; external systems remain authoritative for code, databases and deployments.

## Licence and attribution

Saga's visual language is original. It uses no third-party game names, logos, characters,
monsters, fonts, artwork or sound effects, and no other third-party game assets.
