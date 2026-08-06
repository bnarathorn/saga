# Saga

> **No agent starts at level one.**

Saga is shared project memory, work continuity and coordination for coding agents. A new session
should never have to rediscover a project from zero: Saga remembers what the project _is_, what was
already done, what is in progress, what is blocked, and who else is working right now.

```text
Saga
├── Lore     Project knowledge and persistent memory
├── Quest    Work continuity: sessions, checkpoints and handoffs
├── Party    Agents and live coordination
└── Shrine   Server health, workers, jobs, alerts and operations
```

The web console is called **Guild Hall**. Agents connect over MCP — Codex, Claude and anything else
that speaks it — or through the typed `@saga/agent-sdk`.

---

## Quick start

Nine steps from nothing to a coding agent using Saga. Paste each command, check the result under it,
move on. Everything runs on one machine; to split them, replace `localhost` with the server's
address everywhere.

**You need** `git`, Docker with the Compose v2 plugin, and ports 8080 and 5432 free. No pnpm and no
Node — step 6 downloads a pre-built CLI.

```bash
docker compose version            # v2.x — not `docker --version`
ss -ltn | grep -E ':8080|:5432'   # prints nothing
```

### 1 · Get the code

```bash
git clone https://github.com/bnarathorn/saga.git saga
cd saga
```

_Check:_ `ls docker-compose.yml` prints the filename.

### 2 · Create the configuration

Edit the lines in place — do not append. Saga's own loader is first-wins and Compose's is last-wins,
so a duplicated key would resolve differently for each.

```bash
cp .env.example .env
sed -i \
  -e "s|^SAGA_SESSION_SECRET=.*|SAGA_SESSION_SECRET=$(openssl rand -hex 32)|" \
  -e "s|^SAGA_BOOTSTRAP_ADMIN_PASSWORD=.*|SAGA_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 12)|" \
  -e "s|^SAGA_WEB_PORT=.*|SAGA_WEB_PORT=8080|" \
  -e "s|^SAGA_PUBLIC_URL=.*|SAGA_PUBLIC_URL=http://localhost:8080|" \
  .env
```

_Check:_ `grep SAGA_BOOTSTRAP .env` prints an email and a 24-character password. Keep both — step 4
needs them.

`SAGA_WEB_PORT` and `SAGA_PUBLIC_URL` both ship pointing at 4320, the dev-server port. They have to
move together: the first is the port nginx publishes, the second is the address the device-flow link
in step 7 is built from.

### 3 · Start it

```bash
docker compose up -d --build
```

The first build takes a few minutes.

_Check:_ `docker compose ps` shows `saga-postgres-1`, `saga-api-1`, `saga-worker-1` and
`saga-web-1` running. `saga-migrate-1` is `exited (0)` — that one is meant to finish.

### 4 · Sign in

Open <http://localhost:8080> and sign in with the email and password from step 2.

_Check:_ you land on the Dashboard, showing System health.

### 5 · Create a project

**Projects → Create**, named after the codebase your agent will work on. Write the name down: step 8
selects the project by it.

_Check:_ the project appears, with a banner saying **Lore bootstrap is required**.

### 6 · Install the `saga` command

The server hands out the CLI itself — no repository, no package manager:

```bash
mkdir -p ~/.local/bin
curl -fsSL http://localhost:8080/api/cli/saga -o ~/.local/bin/saga
chmod +x ~/.local/bin/saga
```

_Check:_ `saga --version` prints a version — `0.1.0+g<commit>.<timestamp>`, which names the build
the server is serving rather than the release.

`~/.local/bin` has to be on `PATH` for good, not just in this terminal: step 7 writes an
`.mcp.json` whose command is the bare word `saga`.

### 7 · Connect your codebase

In the folder your agent will work on — **not** the Saga folder:

```bash
cd ~/work/your-project
saga connect --server http://localhost:8080
```

_Check:_ it prints a link with a code, then waits:

```text
Authorize this machine:
  1. Open http://localhost:8080/device?code=ABCD-1234
  2. Sign in and approve the code ABCD-1234

Waiting for approval…
```

Nothing here picks the project — the token is minted bound to whatever step 8 selects.
`--project "Your Project"` only _asserts_ the answer, failing the folder rather than binding it to
the wrong project when several approvals are in flight.

### 8 · Approve the machine

1. Open that link in the browser where you are already signed in.
2. Confirm the code matches the terminal.
3. Pick the project from step 5. This is where the project is chosen, and it cannot be changed
   without approving again.
4. Click **Approve**.

_Check:_ the terminal finishes on its own and prints `Project: Your Project`, followed by the
`.mcp.json` it wrote. That name came from the server — if it is not the one you meant, approve a
fresh request and run `saga connect --reauth`.

### 9 · Confirm it works

```bash
saga doctor
```

_Check:_ the last line ends in `0 failure(s)`.

```text
  12 ok, 1 warning(s), 0 failure(s)
```

Warnings about plain HTTP, and about the token living in a credential file rather than a keychain,
are both expected on a local install. Only `failure(s)` matters.

### Done

Start your coding agent in that folder. It picks up `.mcp.json` by itself and opens a Saga session
on its first message. Give it a task and watch the project fill in at <http://localhost:8080>.

**Lore bootstrap is required** is not a task for you. A new project has no knowledge in it yet, so
the first session hands the agent a plan for what to read; the agent writes the Lore itself as it
works.

> **Before anyone else depends on this.** The quick start runs over plain HTTP with
> `NODE_ENV=development` and the bootstrap password still in `.env`. That is fine for one person on
> one machine and not for a team. A real deployment is a different shape, not an extra step on top
> of this one — see [`docs/operations.md`](docs/operations.md).

---

## If something went wrong

| Symptom                                            | Do this                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker: 'compose' is not a docker command`        | Compose v2 is a separate plugin. Install `docker-compose-plugin`, or take the systemd route in [`docs/operations.md`](docs/operations.md), which needs no Docker.            |
| `docker compose up` fails on `SAGA_SESSION_SECRET` | Step 2 did not run. Re-run it, then `docker compose up -d --build`.                                                                                                          |
| Port 8080 or 5432 already in use                   | Set `SAGA_WEB_PORT` and `SAGA_PUBLIC_URL` in `.env` to the new port (or `SAGA_POSTGRES_PORT`), then use it in every URL above.                                               |
| The console loads but says Saga is unreachable     | `docker compose logs api`                                                                                                                                                    |
| `saga: command not found`                          | `~/.local/bin` is not on `PATH` — Debian and Ubuntu add it only if the directory existed at login. `export PATH="$HOME/.local/bin:$PATH"`, and put it in your shell profile. |
| Step 6's `curl` 404s or writes an empty file       | That server has no CLI build. Compose builds one into the image, so the usual cause is an API started from a working tree — run `pnpm --filter @saga/cli bundle` there once. |
| The folder is bound to the wrong project           | `saga status` names the current binding. Approve a fresh request for the project you want, then `saga connect --reauth`.                                                     |
| The approval link 404s                             | The code expired after ten minutes. Ctrl-C and re-run step 7.                                                                                                                |
| Start over completely                              | `docker compose down -v`, then step 2.                                                                                                                                       |

---

## Documentation

| Document                                                 | Covers                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| [`docs/agent-integration.md`](docs/agent-integration.md) | MCP setup, session policy, tools, checkpoints                |
| [`docs/operations.md`](docs/operations.md)               | Real deployments, upgrades, backups, troubleshooting         |
| [`docs/architecture.md`](docs/architecture.md)           | Domains, state ownership, boundaries                         |
| [`docs/api.md`](docs/api.md)                             | Endpoints, error codes, pagination, idempotency              |
| [`docs/security.md`](docs/security.md)                   | Authentication, token scopes, secrets, audit                 |
| [`docs/testing.md`](docs/testing.md)                     | Test strategy and how to run each suite                      |
| [`docs/adr/`](docs/adr/)                                 | Architecture decision records                                |
| [`AGENTS.md`](AGENTS.md)                                 | Working on Saga itself: invariants, settled questions, traps |

Developing Saga rather than using it needs Node.js 22+, pnpm 9+ and PostgreSQL 15+ with `pgvector`,
`pg_trgm` and `pgcrypto`; `pnpm install && pnpm db:migrate && pnpm dev` brings up the API, the worker
and Guild Hall together. [`AGENTS.md`](AGENTS.md) covers the rest.

---

## Licence

Released under the [MIT Licence](LICENSE).
