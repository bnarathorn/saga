# Saga — Security

What Saga protects, how, and what it deliberately does not do.

---

## 1. Two authentication models

Humans and agents authenticate differently on purpose (ADR-0003). Sharing one credential type
would either give agents console-wide powers or force humans through a token flow.

### Web sessions

- Opaque 32-byte random session ids; only a SHA-256 hash is stored.
- `saga_session` cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when configured. The process
  refuses to start in production unless `SAGA_COOKIE_SECURE=true`.
- The session id is rotated on every successful authentication.
- Revocation is a single `UPDATE` and takes effect immediately — no JWT, nothing to wait out.
- Passwords use **Argon2id** (`m=19456 KiB, t=2, p=1`), the OWASP second-choice profile,
  chosen because the reference deployment target is a small self-hosted machine where the
  46 MiB profile would make concurrent logins contend for memory.
- Login is rate limited and locks after 5 failures for 15 minutes. An unknown address and a
  wrong password return the *same* message, and an unknown address still costs a verify, so
  neither timing nor wording enumerates accounts.

### Agent tokens

- Format `saga_<projectSlug>_<40 chars>`. The slug is a non-secret hint for operators; all the
  entropy is in the last segment.
- **Bound to exactly one project** and to an explicit scope list.
- Only a SHA-256 hash is stored. The raw value is returned exactly once, at creation.
- Revocable, optionally expiring; revocation takes effect on the next request.

---

## 2. CSRF

Cookie-authenticated mutations require `X-Saga-CSRF` to match the readable `saga_csrf` cookie
*and* to hash to the value stored with the session. `SameSite=Lax` alone does not cover every
case, so the double-submit check is not optional.

Bearer-token callers are exempt: they are not cookie-driven, so there is nothing for a browser
to forge.

---

## 3. Authorization

Two independent maps onto one permission set. Agent scopes are a strict subset — an agent can
never operate Shrine or manage security, whatever scopes it holds.

| Permission | viewer | operator | admin | agent scope |
| ---------- | :----: | :------: | :---: | ----------- |
| `project:read` | ✓ | ✓ | ✓ | `project:read` |
| `project:write` |  | ✓ | ✓ | — |
| `project:archive` |  |  | ✓ | — |
| `lore:read` | ✓ | ✓ | ✓ | `lore:read` |
| `lore:propose` |  | ✓ | ✓ | `lore:propose` |
| `lore:publish` |  | ✓ | ✓ | `lore:publish` |
| `lore:archive` |  | ✓ | ✓ | — |
| `quest:read` | ✓ | ✓ | ✓ | `quest:read` |
| `quest:write` |  | ✓ | ✓ | `quest:write` |
| `party:read` | ✓ | ✓ | ✓ | `party:heartbeat`, `party:claim` |
| `party:heartbeat` |  | ✓ | ✓ | `party:heartbeat` |
| `party:claim` |  | ✓ | ✓ | `party:claim` |
| `party:revoke` |  | ✓ | ✓ | — |
| `shrine:read` | ✓ | ✓ | ✓ | `project:read` |
| `shrine:operate` |  | ✓ | ✓ | — |
| `security:manage` |  |  | ✓ | — |

An operator holds `party:heartbeat` and `party:claim` so that a human is never *less* capable
inside a project than an agent token issued for it.

### Cross-project isolation

A token scoped to project A that asks about project B receives **404, not 403**. A 403 would
confirm that B exists, which is exactly what project scoping is meant to prevent. This holds
across every project-scoped route and is asserted in the security suite.

---

## 4. Secrets

### Never stored in Lore

Before a candidate version is written, `body`, `data` and `evidence` are scanned for PEM and
OpenSSH private keys, AWS access keys and secret keys, GitHub, Slack, Google and Stripe
tokens, JWTs, bearer tokens, credential-bearing URLs, and literal password/secret/API-key
assignments. Any field literally named `password`, `secret`, `api_key`, `token`,
`private_key`, `client_secret` or similar is treated as a secret whatever its shape.

The policy **rejects** rather than redacts, and the error names the field path without ever
echoing the value:

```json
{ "error": { "code": "MEMORY_SECRET_DETECTED",
             "details": { "findings": [{ "field_path": "data.steps[1]", "rule": "google_api_key" }] } } }
```

Documentation placeholders (`${VAR}`, `<password>`, `REDACTED`, `changeme`, `$VAR`, `%VAR%`)
pass, so an entry can still show the *shape* of a connection string and name which environment
variables exist.

### Never written to logs

Pino `redact` paths cover `password`, `token`, `secret`, `api_key`, `authorization`,
`private_key`, request cookies and the CSRF header, plus wildcards for the arbitrary `details`
bags on errors. `body`, `work_state` and `payload` are redacted **wholesale**: Lore bodies and
checkpoint payloads are private project content, not debugging material. A shared text
redactor also strips credential-bearing URLs, bearer tokens, PEM blocks and Saga tokens from
free text.

### Never shown in Shrine

`/api/shrine/config` shows host and database *name*, TLS, embedding profile, worker settings,
retention, context budgets and Party mode. It never shows credentials, full DSNs, the session
secret or agent tokens. Job payloads are summarised, never returned raw, because they may
reference local paths.

---

## 5. Privacy of local detail

- `workspace_key` is a hash of machine identity plus canonical root. It is used to detect two
  agents in the same folder, and is **never** returned by any API.
- `workspace_label` is sanitised: an absolute path is reduced to its last segment, so a viewer
  sees `machine-a:erp-main`, not `/home/alice/projects/erp-main`.
- Evidence records **paths and hashes**, not file contents.
- A claim conflict names the owning Quest, its client and the lease expiry — never the other
  agent's task text, scope detail or files.
- The Quest-matching explanation goes to the server log, not to the API response, because it
  can quote task text.

---

## 6. Transport and request hardening

- Same-origin by default. CORS allows only `SAGA_PUBLIC_URL` plus explicitly configured
  origins; a request with no `Origin` (the CLI, curl) is allowed as non-browser.
- `@fastify/helmet` sets the standard headers; the CSP for Guild Hall lives in the nginx
  config, since nginx serves it.
- Request bodies are capped by `SAGA_MAX_BODY_BYTES` (1 MiB default) and again by nginx.
- Rate limits: login and device-flow endpoints have their own, tighter than the general API
  limit, all configurable.

---

## 7. Audit

Every administrative mutation is recorded in `security.audit_logs` with actor, action,
project, entity, **reason** and request id: login, project create/rename/archive/restore,
token issue and revoke, device approval, Lore publish/mark-stale/archive, Quest reopen, job
retry/cancel/requeue, and claim revocation.

Disruptive actions **require** a reason, enforced by the contract, not by convention:
archiving a project, cancelling or retrying a job, reopening a Quest, revoking a token, and
revoking a claim. Claim revocation additionally requires explicit `confirm: true`, because it
takes a resource away from an agent that may still be using it.

---

## 8. The development bypass

`SAGA_DEV_AUTH_BYPASS=true` treats every request as an administrator. It is guarded three ways:

1. `loadConfig` throws if it is combined with `NODE_ENV=production` — the process cannot start.
2. Shrine reports `degraded` with an explicit warning whenever it is on.
3. `/api/shrine/config` exposes `dev_auth_bypass: true` so it is visible in the console.

---

## 9. Non-goals

Saga does not implement source control, merge code, execute deployments, provide remote shell
access, or run arbitrary jobs on request. Shrine deliberately has **no** command runner,
terminal, or job-payload editor: the only job an operator can enqueue is a bounded `noop`
probe.

---

## 10. Reporting a vulnerability

This is a self-hosted, single-tenant system. If you find a security problem, open a private
issue with reproduction steps and the affected version from `/api/shrine/config`.
