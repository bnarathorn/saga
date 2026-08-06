# Saga — Operations

Running, upgrading, backing up and troubleshooting a self-hosted Saga.

---

## 1. Reference deployment

```text
              ┌──────────┐
   browser ──▶│  nginx   │──▶ static Guild Hall build   (survives an API outage)
              │          │──▶ 127.0.0.1:4319  Saga API
              └──────────┘
                              Saga worker  (no inbound port)
                              PostgreSQL 16 + pgvector
                              Ollama (optional)
```

Guild Hall is served by nginx directly from a static build, deliberately **independent of the
API process**: when the API is down the console still loads and says so. An external monitor
must still check `/health/live` and `/health/ready`, because a console served from the same
host cannot diagnose a fully unavailable host.

Assets: [`deploy/nginx/guild-hall.conf`](../deploy/nginx/guild-hall.conf),
[`deploy/systemd/`](../deploy/systemd/), [`deploy/docker/`](../deploy/docker/).

### systemd

Nothing here needs Docker. Node 22+ must be on a system-wide path — the units run
`/usr/bin/node`, so an `nvm`, `fnm`, `asdf` or Volta install under a home directory is invisible
to the service account.

**1. The service account.**

```bash
sudo useradd --system --home /opt/saga --shell /usr/sbin/nologin saga
```

**2. Build the release into `/opt/saga`.** The units run
`/usr/bin/node apps/server/dist/main.js` with `WorkingDirectory=/opt/saga`, so that directory has
to be a built checkout — source, `node_modules` and `dist` together.

```bash
sudo install -d -o "$USER" -g "$USER" /opt/saga
git clone https://github.com/bnarathorn/saga.git /opt/saga
cd /opt/saga
PNPM_STORE_DIR=/opt/saga/.pnpm-store pnpm install --frozen-lockfile
pnpm build                          # server, worker, Guild Hall's static build, and the CLI
sudo chown -R saga:saga /opt/saga
sudo install -m 755 deploy/saga-tools /usr/local/bin/saga-tools
```

Build as an administrator and hand the tree over afterwards, as above: the units never write to
`/opt/saga`, so the `saga` account only ever needs to read it. Every upgrade after this one goes
through `saga-tools`, which builds as that account with a home elsewhere and needs neither
`chown` pass — see the [upgrade procedure](#upgrade-procedure).

`PNPM_STORE_DIR` keeps that `chown` inside this tree. pnpm hardlinks packages into
`node_modules` from a content-addressable store in the deploying user's home, and ownership
belongs to the inode rather than the path, so a recursive `chown` follows those links and
rewrites the store too — after which that user's next `pnpm install` anywhere on the machine
fails with `EPERM: operation not permitted, chmod`. The upgrade procedure below carries the same
flag for the same reason. Do not run `pnpm link --global` on the server — the `saga` CLI belongs
on developer machines ([agent-integration.md](agent-integration.md)), and against a checkout the
invoking user no longer owns it fails with `EPERM … chmod` while still exiting `0`.

**3. The database.** One database, one role, three extensions. The Compose path gets these from
its postgres image; here you create them.

```bash
# Debian and Ubuntu ship neither the 16 packages nor pgvector in their default repositories.
# Add PostgreSQL's own first: https://wiki.postgresql.org/wiki/Apt
sudo apt install postgresql-16 postgresql-16-pgvector

sudo -u postgres psql <<'SQL'
CREATE ROLE saga LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'a strong password';
CREATE DATABASE saga OWNER saga;
SQL

sudo -u postgres psql -d saga <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
```

`db/migrations/0001_initial.sql` issues those three `CREATE EXTENSION` statements itself, but
creating them as `postgres` first means the migration role does not need the privilege, which is
what lets the application role be `NOSUPERUSER`. pgvector has to be installed as a server package
first or `CREATE EXTENSION vector` fails with `could not open extension control file`.

**4. Configuration.**

```bash
sudo install -d -o root -g saga -m 0750 /etc/saga
sudo install -o root -g saga -m 0640 deploy/systemd/saga.env.example /etc/saga/saga.env
sudoedit /etc/saga/saga.env
```

The example sets `NODE_ENV=production`, `SAGA_COOKIE_SECURE=true` and `SAGA_API_HOST=127.0.0.1`.
Replace `SAGA_SESSION_SECRET`, `DATABASE_URL`, `SAGA_PUBLIC_URL` and
`SAGA_BOOTSTRAP_ADMIN_PASSWORD`. There is no signup page and no default account: without both
`SAGA_BOOTSTRAP_ADMIN_*` values the server starts correctly and nobody can sign in. Delete the
password line once you have signed in and restart `saga-api`. systemd reads the file directly, so
values are not shell-expanded and need no quoting.

**5. Embeddings.** The example points at Ollama and `nomic-embed-text` but installs neither.

```bash
ollama pull nomic-embed-text
ollama show nomic-embed-text | grep 'embedding length'   # 768
```

Any other width dead-letters every embedding job while Lore keeps publishing text-only — see
[ADR-0006](adr/) and section 5 of the setup guide. Set `SAGA_EMBEDDING_PROVIDER=openai` to skip
this step.

**6. Start the units.**

```bash
sudo cp deploy/systemd/saga-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now saga-migrate saga-api saga-worker
curl -s localhost:4319/health/ready
```

`saga-api` and `saga-worker` both `Requires=saga-migrate.service`, so the schema is current
before either serves traffic. The units are hardened: no new privileges, private tmp and
devices, `ProtectSystem=strict`, an empty capability bounding set, a `@system-service` syscall
filter and `UMask=0077`. Nothing under `/opt/saga` needs to be writable at runtime.

**7. nginx.** Copy the static build somewhere nginx serves it, then install both configuration
files — `guild-hall.conf` includes `saga-headers.conf`, which resolves against nginx's prefix.

```bash
sudo install -d -o www-data -g www-data /var/www/saga-app
sudo rsync -a --delete /opt/saga/apps/web/dist/ /var/www/saga-app/
sudo cp deploy/nginx/guild-hall.conf /etc/nginx/sites-available/
sudo cp deploy/nginx/saga-headers.conf /etc/nginx/
sudo ln -s /etc/nginx/sites-available/guild-hall.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Guild Hall is independent of the API, so it has to be republished on every upgrade — that
`rsync` is one of the steps `saga-tools update` performs for you. `server_name`, the two
`ssl_certificate` paths and `root` are
placeholders; `nginx -t` fails until the certificate exists, which is deliberate, because
`SAGA_COOKIE_SECURE=true` makes a plaintext origin a console nobody can sign in to.

If the API, nginx and a `saga` CLI all live on one host and `SAGA_PUBLIC_URL` is a public name,
that host may not be able to reach itself by it — most routers do not hairpin, so the name
resolves to a WAN address that refuses the connection and `saga connect` fails before it starts.
A split-horizon `/etc/hosts` entry pointing the name at `127.0.0.1` fixes it without changing
`SAGA_PUBLIC_URL`.

### Docker Compose

```bash
cp .env.example .env
# Edit the existing lines in place rather than appending: Saga's own config loader resolves
# a duplicate key first-wins, the opposite of Docker Compose's last-wins, so an appended
# line would only take effect for whichever process reads it that way.
sed -i "s|^SAGA_SESSION_SECRET=.*|SAGA_SESSION_SECRET=$(openssl rand -hex 32)|" .env
# .env.example ships development defaults for the quickstart in README.md. A reference
# deployment is a production deployment: pin NODE_ENV=production so the config loader's
# guards actually run (session-secret length, the dev-auth-bypass refusal, and the
# SAGA_COOKIE_SECURE requirement below), and set SAGA_COOKIE_SECURE=true so session and
# CSRF cookies carry the Secure flag. docker-compose.yml only defaults NODE_ENV to
# production when .env omits the key entirely — it does not set it for you.
sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" .env
sed -i "s|^SAGA_COOKIE_SECURE=.*|SAGA_COOKIE_SECURE=true|" .env
# .env.example points SAGA_PUBLIC_URL at the Vite dev-server port, which is only reachable
# on the loopback interface of a workstation running the quickstart. A reference deployment
# sits behind nginx (deploy/nginx/guild-hall.conf), which terminates TLS, so SAGA_PUBLIC_URL
# must be the external HTTPS origin operators and other services actually reach — not the
# container's internal port. Replace the placeholder below with that origin. Three things
# derive from this value: the CORS allowlist (apps/server/src/app.ts), the device-flow
# verification URL sent to agents (${SAGA_PUBLIC_URL}/device), and whether Shrine reports
# TLS as enabled (it infers this from the URL's scheme, so a localhost or http:// value here
# makes Shrine misreport a TLS deployment as plaintext).
sed -i "s|^SAGA_PUBLIC_URL=.*|SAGA_PUBLIC_URL=https://saga.example.internal|" .env
docker compose up -d --build
docker compose --profile ollama up -d      # optional local embeddings
```

The `migrate` service runs to completion before `api` and `worker` start.

---

## 2. Configuration

Every variable is documented in [`.env.example`](../.env.example). The ones that matter most:

| Variable                  | Notes                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`            | Required. Never appears in logs or in Shrine configuration.                                                              |
| `SAGA_SESSION_SECRET`     | 32+ random bytes. Rotating it invalidates every web session.                                                             |
| `SAGA_API_HOST`           | `127.0.0.1` behind nginx; `0.0.0.0` in a container.                                                                      |
| `SAGA_COOKIE_SECURE`      | Must be `true` in production — the process refuses to start otherwise.                                                   |
| `SAGA_DEV_AUTH_BYPASS`    | Must be `false`. The process refuses to start in production with it on, and Shrine reports `degraded` whenever it is on. |
| `PARTY_MODE`              | `off`, `advisory` or `strict`. `off` leaves Lore and Quest fully working.                                                |
| `SAGA_EMBEDDING_PROVIDER` | `fake` (deterministic, no server) or `ollama`.                                                                           |
| `SAGA_WORKER_CONCURRENCY` | Jobs in flight per worker process.                                                                                       |
| `SAGA_JOB_LEASE_SECONDS`  | Longer than your slowest handler, or work will be reclaimed mid-flight.                                                  |

Shrine shows the sanitized configuration at `/api/shrine/config`: host and database name, TLS,
embedding profile, worker settings, retention, context budgets and Party mode. Never
credentials, full DSNs, session secrets or agent tokens.

---

## 3. Database

### Migrations

Forward-only. The runner takes a PostgreSQL advisory lock, verifies the checksum of every
already-applied migration, applies pending ones in numeric order, and wraps each in a
transaction. **An applied migration is immutable**: editing one is refused with
`SCHEMA_VERSION_MISMATCH`. Add a new forward migration instead.

A migration whose first line is `-- saga:no-transaction` runs outside a transaction, for DDL
PostgreSQL will not accept inside one — in practice `CREATE INDEX CONCURRENTLY`, which is how
an index is added to a busy table without a plain `CREATE INDEX`'s `ShareLock` blocking every
write for the length of the build. Such a migration records its ledger row separately from the
DDL, so it must be written idempotently (`IF NOT EXISTS`): a crash between the two leaves it
pending and re-runnable.

```bash
pnpm db:status     # current vs expected version
pnpm db:migrate    # apply pending
```

`pnpm db:reset` drops and re-applies every schema. It is refused when `NODE_ENV=production`.

### Upgrade procedure

1. **Back up first.** `pg_dump` before every upgrade; forward-only migrations have no `down`.
2. Read the release notes for migrations that rewrite data.
3. Deploy:

   ```bash
   saga-tools status     # deployed commit, whether the remote is ahead, what is being served
   saga-tools update
   ```

   `deploy/saga-tools`, installed as `/usr/local/bin/saga-tools`, is the only path. It fetches
   the published branch into `/opt/saga` as the service account — the repository is public, so
   no credential is involved — fast-forwards, and then does the rest itself:
   `pnpm install --frozen-lockfile`, `pnpm build`, `rsync` of `apps/web/dist` into nginx's root,
   `systemctl restart saga-migrate` and then `saga-api saga-worker`. After the fast-forward it
   re-execs the copy of itself in the tree it just fetched whenever that differs from the one
   running, so an upgrade picks up changes to the upgrade procedure itself — and says so, since
   `/usr/local/bin/saga-tools` is still the old copy until you reinstall it:

   ```bash
   sudo install -m 755 /opt/saga/deploy/saga-tools /usr/local/bin/saga-tools
   ```

   **One time only**, on a server still running the version that predates this: that copy ends
   by exec'ing `deploy/update.sh`, which no longer exists. It will fetch and fast-forward
   correctly and then fail with `No such file or directory`, leaving the tree moved but not
   built — the state `saga-tools status` warns about. Run the `install` above, then
   `saga-tools rebuild`.

   It refuses rather than guesses. A tree with uncommitted tracked changes, or a remote whose
   history was rewritten so the deployed commit is no longer an ancestor, both stop it before
   anything moves, and the rewritten-history message names the `reset --hard` that would
   deliberately discard the deployed commit.

   A commit reaches production by being on the published branch — there is no second route.
   Push the hotfix, then upgrade. (There used to be a `deploy/update.sh` that carried an
   unpushed commit across as a git bundle, from when the repository was private. It was removed
   once fetching needed no credential.)

4. Verify. `saga-tools update` already polls `/api/cli/saga` until the served CLI is stamped
   with the commit it deployed, and fails if it is not. Then check `/api/shrine/schema`:
   `current_version` must equal `expected_version`. It needs authentication; `/health/ready`
   reports the same two numbers without a token.

**Why the build runs as the service account.** `/opt/saga` is owned by `saga` so the units can
read it and nothing else can write it at runtime — but a build has to write `dist/` into that
tree, so something must own it. The alternative is to take the tree (`chown -R "$USER"`), build,
and hand it back, and that route has a trap worth knowing about even though the scripts avoid
it: pnpm hardlinks packages from a content-addressable store in the deploying user's home rather
than copying them, and ownership is a property of the inode, so `chown -R saga:saga /opt/saga`
follows every one of those links and rewrites the shared store as well. The symptom arrives
later and nowhere near the cause — any `pnpm install` by that user then dies on
`EPERM: operation not permitted, chmod`, and the only repair is deleting the store and
re-downloading it. Taking that route means pinning `PNPM_STORE_DIR` inside `/opt/saga` first.

Building as `saga` sidesteps both the chown passes and the store, at the cost of one constraint:
that account's home _is_ `/opt/saga`, so the build must be given a home elsewhere or it leaves
`.cache/` and `.npm/` inside the checkout. Both scripts set `HOME=/var/tmp/saga-build-home`,
which also keeps the pnpm store out of the tree. `pnpm store prune` there reclaims what old
deploys left behind.

**Failure behaviour.** If a migration fails, earlier migrations stay applied and the failing
one is not recorded, so the ledger is accurate and the run is repeatable after a fix. One
exception needs a human: a failed `CREATE INDEX CONCURRENTLY` leaves an _invalid_ index behind,
which the migration's `IF NOT EXISTS` will then skip on the retry. Check for one before
retrying, and drop it if present:

```sql
SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE NOT i.indisvalid;
```

The API refuses to report ready while the schema version disagrees with the build, so an
orchestrator will not route traffic to it.

**Rollback.** There is none for the schema. Rolling _the application_ back is safe only while
the older build still understands the newer schema; otherwise restore the backup. This is the
intended friction — it is why step 1 exists.

### Backup and recovery

```bash
pg_dump --format=custom --file=saga-$(date +%F).dump "$DATABASE_URL"
```

That single database holds everything durable: projects, Lore and its full version history,
Quests, checkpoints and handoffs, security records and audit logs. It does **not** hold your
source code, and Saga is not a backup of it.

Restore:

```bash
systemctl stop saga-api saga-worker
pg_restore --clean --if-exists --dbname "$DATABASE_URL" saga-2026-03-01.dump
systemctl start saga-migrate saga-api saga-worker
```

Live coordination state (agent runs, claims) is leased, so anything stale after a restore
expires on its own rather than blocking work.

---

## 4. The worker

```text
1. register or renew the service-instance heartbeat
2. claim jobs with FOR UPDATE SKIP LOCKED and a fresh per-attempt claim token
3. run the handler, renewing the lease for long work
4. complete, retry, fail or cancel — always guarded by the claim token
5. periodically recover jobs whose worker died
```

A worker may only complete a job whose claim token still matches, so a worker that hung past
its lease cannot overwrite the replacement worker's result.

| Job type            | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `embedding`         | Vectors for Lore versions and Quests                 |
| `memory_validation` | Validate, prepare a snapshot, publish in `auto` mode |
| `context_snapshot`  | Rebuild core context after a stale/archive change    |
| `stale_detection`   | Compare reported evidence against recorded hashes    |
| `outbox_delivery`   | Drain the transactional outbox                       |
| `event_projection`  | Repair gaps in the Shrine feed (see below)           |
| `session_reaper`    | Mark silent sessions abandoned                       |
| `party_reaper`      | Expire agent runs and release their claims           |
| `cleanup`           | Retention                                            |
| `noop`              | A deterministic probe for operators                  |

Outbox delivery also runs _inline_ on the worker's timer rather than as one queue row per
second — enqueuing at that rate would bury real work under bookkeeping.

Delivery projects each event into `shrine.system_events`, which is what Guild Hall and the SSE
stream read. That projection is keyed on the outbox event id by a unique index, so
at-least-once redelivery cannot duplicate a feed entry. `event_projection` re-runs the same
projection over a bounded window and normally finds nothing; enqueue it if the feed has gaps:

```sql
INSERT INTO shrine.jobs (job_type, payload)
VALUES ('event_projection', '{"window_hours": 168}'::jsonb);
```

Graceful shutdown: stop claiming, let in-flight work finish within the timeout, stop renewing
leases so anything still running is recovered elsewhere, then close the pool.

---

## 5. Health

| Status      | Meaning                              |
| ----------- | ------------------------------------ |
| `healthy`   | Everything nominal.                  |
| `degraded`  | Working, but attention is warranted. |
| `unhealthy` | Cannot serve correctly.              |
| `unknown`   | The check could not be evaluated.    |

Degraded examples: the embedding provider is unavailable while text search still works; no
worker holds a live lease; the oldest queued job is older than the warning threshold; failed
jobs exist; the development auth bypass is on.

Unhealthy examples: the database is unreachable; the schema version is incompatible; required
configuration is missing.

`/health/live` never touches the database — otherwise a database outage would make an
orchestrator restart perfectly healthy processes. `/health/ready` is the one that checks
dependencies.

Liveness of API, worker and agent runs is always derived from `lease_expires_at > now()`,
never from a stored state column.

---

## 6. Observability

Structured JSON logs on stdout, collected by journald or your container runtime. Correlation
fields: `request_id`, `correlation_id`, `project_id`, `session_id`, `quest_id`,
`agent_run_id`, `job_id`, `job_type`, `operation`, `error_code`, `latency_ms`.

**Never logged**: agent tokens, passwords, Lore bodies, raw checkpoint payloads, private file
contents, credential-bearing URLs. Redaction is enforced by pino `redact` paths plus a shared
text redactor, and asserted by tests.

`/api/shrine/metrics-summary` is the metrics endpoint. It carries:

| Group                    | Source              | Contents                                                                        |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------- |
| `jobs`, `outbox`         | PostgreSQL          | queue depth by state, oldest queued age, outbox backlog                         |
| `services`               | PostgreSQL          | live API and worker instances                                                   |
| `heartbeat_age_seconds`  | PostgreSQL          | seconds since the last heartbeat per role                                       |
| `party`, `lore`, `quest` | domain contributors | active agent runs and claims, Lore entries and stale count, open/blocked Quests |
| `sse`                    | in-process          | connected stream clients                                                        |
| `http`                   | in-process          | request count, request latency, error count by stable error code                |
| `search`, `context`      | in-process          | search count, text-only fallback count, contexts built, tokens emitted          |
| `latency`                | mixed               | see below                                                                       |

`latency` mixes two sources. `lore_publish`, `lore_search` and `context_build` are timed
in-process by the API instance answering the request. `memory_validation`, `context_snapshot`
and `embedding` are computed from `shrine.jobs` (`completed_at - claimed_at`) over the last
hour, so they cover the worker too. In `auto` approval mode the publish transaction runs
inside the `memory_validation` job, so its cost appears there rather than under `lore_publish`.

In-process counters belong to one API instance and reset when it restarts; `http.since` states
when counting began. Everything read from PostgreSQL is cluster-wide and survives restarts.

`shrine.health_changed` is written whenever the overall health status changes — a transition
only, never one row per evaluation — and reaches Guild Hall over SSE like any other event. The
API evaluates health for this purpose every six heartbeat intervals (60 s by default) and
recovers the last known status from the feed on startup, so a restart does not re-announce a
status that is already recorded.

---

## 7. Troubleshooting

**Jobs are not being processed.** Check `/api/shrine/services` for a worker with `live: true`.
If none, the worker is down or cannot reach the database. If one is live but the queue is
growing, look at `oldest_queued_age_seconds` and at failed jobs.

**A job is stuck in `claimed`.** Its worker died. The reaper recovers it once the lease
expires; `POST /api/shrine/jobs/:id/requeue` forces it immediately.

**Lore is not publishing.** Look at the update state. `failed` carries the reason — usually
the secret policy. `conflict` means an entry changed since the proposal; the proposer must
re-read and propose again. Stuck in `validating` usually means embedding jobs are failing:
after a bounded number of attempts, validation proceeds text-only rather than blocking.

**Search returns `degraded`.** The embedding provider is unavailable. Full-text and trigram
search still work; embeddings catch up when it returns. Check the `embedding_provider` health
check.

**An agent cannot claim a resource.** The 409 body names the owning Quest, its client and the
lease expiry. Wait for expiry, coordinate, or revoke administratively — revocation requires
confirmation and a reason, and is audited.

**A session is stuck in `awaiting_task`.** It never received a first task. The session reaper
marks it abandoned after `SAGA_SESSION_ABANDON_AFTER_MINUTES`. Its checkpoints, if any, remain
usable as a continuation.

**Guild Hall loads but shows the API as unreachable.** Static assets are served by nginx
independently of the API, which is exactly the intended behaviour. Check the API process and
`/health/ready`.

**`saga doctor` reports the credential store as a file.** No OS keychain helper was found.
Install `libsecret-tools` on Linux, or set `SAGA_TOKEN` for non-interactive use. The token
file is mode 0600. With `SAGA_TOKEN` set, the check reports `environment` and is not a
warning — that token is used in preference to anything stored.

---

## 8. Retention

The `cleanup` job removes operational exhaust only:

| Data                         | Default                                                |
| ---------------------------- | ------------------------------------------------------ |
| Finished jobs                | 14 days                                                |
| Delivered outbox rows        | 30 days                                                |
| System events                | 30 days                                                |
| Idempotency records          | 24 hours                                               |
| Expired web sessions         | immediately                                            |
| Expired device codes         | marked expired immediately; row deleted after 24 hours |
| Dead service instances       | 24 hours                                               |
| Superseded context snapshots | 30 days, keeping the 5 most recent per project         |

Delivered outbox rows and superseded context snapshots aren't governed by their own settings —
`cleanup` reuses the system-events cutoff for both, so lowering `SAGA_SYSTEM_EVENT_RETENTION_DAYS`
quietly shortens outbox and snapshot retention along with it.

Device codes go through two steps, not one: a stale pending or approved code is marked
`expired` (and stops working) as soon as it passes its own expiry, but the row is only deleted
once it is a full day past that expiry — the delete runs against a fixed 24-hour cutoff, not the
system-events setting above.

**Durable Lore and Quest history is archived, never deleted.** Marking an entry stale keeps
its content and adds a reason; archiving hides it from search and context but preserves every
version.
