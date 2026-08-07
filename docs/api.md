# Saga — API

Base path `/api`. The machine-readable contract is [`openapi.json`](openapi.json), generated
from the same Zod schemas the API validates with; `pnpm openapi:check` fails CI if it drifts.

---

## Conventions

**Errors** use one envelope, always:

```json
{
  "error": {
    "code": "QUEST_REVISION_CONFLICT",
    "message": "The Quest changed since this checkpoint was created.",
    "details": { "expected_revision": 4, "latest_revision": 5 },
    "request_id": "req_a1b2c3"
  }
}
```

`code` is stable and machine-readable; `message` may change. Every response carries
`x-request-id`, and an inbound `x-request-id` is honoured so a trace survives the proxy hop.

**Status codes**

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 400  | malformed request syntax                                         |
| 401  | unauthenticated                                                  |
| 403  | authenticated but unauthorized                                   |
| 404  | absent, or intentionally hidden from this caller                 |
| 409  | optimistic-concurrency or claim conflict                         |
| 422  | semantically invalid state transition or payload                 |
| 429  | rate limited                                                     |
| 503  | temporarily unavailable, or fail-closed coordination unavailable |

**Timestamps** are ISO-8601 UTC. **Pagination** is keyset-based: pass `limit` (max 200) and
the opaque `next_cursor` from the previous page.

**Idempotency** — pass `Idempotency-Key` on any retryable create or mutation:
project creation, session creation, Quest creation, `lore/remember`, checkpoint creation,
claim acquisition and job retry. A replay with the same body returns the stored response and
sets `idempotency-replayed: true`. A replay with a _different_ body returns
`IDEMPOTENCY_KEY_REUSED` (409) rather than silently returning the old answer.

**Authentication** — two independent models (ADR-0003):

- _Web session_: `saga_session` cookie (HttpOnly, SameSite=Lax). Every mutation additionally
  requires `X-Saga-CSRF` matching the readable `saga_csrf` cookie.
- _Agent token_: `Authorization: Bearer saga_<project>_<secret>`. Bound to exactly one project
  and to an explicit scope list. Only a hash is stored; the raw value is shown once.

---

## Error codes that matter

| Code                       | What to do                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEST_REVISION_CONFLICT`  | Another session checkpointed first. Re-read the Quest, merge your work state with the latest checkpoint, resubmit with the new revision. Never retry blindly. |
| `MEMORY_UPDATE_CONFLICT`   | One or more Lore Entries changed. Re-read the current versions, reapply, propose again. `details.conflicts` names the entries.                                |
| `RESOURCE_CLAIM_CONFLICT`  | Another agent holds the resource. `details` carries the owning Quest, its client and the lease expiry. Do not proceed without the claim.                      |
| `COORDINATION_UNAVAILABLE` | A fail-closed resource and Party is unreachable. Stop, record a checkpoint describing the waiting state.                                                      |
| `MEMORY_SECRET_DETECTED`   | The candidate contained a credential. `details.findings[].field_path` says where; the value is never echoed.                                                  |
| `QUEST_STEP_NOT_FOUND`     | You settled a plan step this Quest does not have. Re-read `GET /api/quests/:questId/plan` before settling any more.                                           |
| `PROJECT_ARCHIVED`         | The project is read-only. Restore it first.                                                                                                                   |
| `SCOPE_REQUIRED`           | The agent token lacks a scope. `details.permission` names it.                                                                                                 |

---

## Endpoint map

### Security

```
POST   /api/auth/login                       sign in (rate limited)
POST   /api/auth/logout                      revoke the session server-side
GET    /api/auth/me                          describe the current actor
POST   /api/auth/device/start                begin the CLI device flow
GET    /api/auth/device/pending               list pending approvals (admin)
POST   /api/auth/device/approve              approve and mint a token (admin)
GET    /api/auth/device/status                poll; the token is returned exactly once
GET    /api/projects/:projectRef/tokens      list agent tokens (admin)
POST   /api/projects/:projectRef/tokens      issue one; raw value shown once
POST   /api/tokens/:tokenId/revoke           revoke; reason required
```

### Projects

```
GET    /api/projects                         list, with per-domain counters
POST   /api/projects                         create — name only
GET    /api/projects/:projectRef             read; ref = uuid | name | normalized | alias
PATCH  /api/projects/:projectRef             rename or update
POST   /api/projects/:projectRef/archive     reason required
POST   /api/projects/:projectRef/restore     reason required
```

Two per-project policies decide what an agent may do unattended, both settable on create and on
`PATCH`, both defaulting to `auto` for a new project:

| Field                   | `auto`                                        | `manual`                                       |
| ----------------------- | --------------------------------------------- | ---------------------------------------------- |
| `lore_approval_mode`    | a proposed Lore update publishes itself       | it waits for approval in Guild Hall            |
| `quest_completion_mode` | a Quest closes when its agent says it is done | the declaration is recorded, a person confirms |

### Lore

```
GET    /api/projects/:projectRef/lore                        list entries + memory_revision
GET    /api/projects/:projectRef/lore/:memoryKey             one entry with relations
GET    /api/projects/:projectRef/lore/:memoryKey/versions    immutable history
POST   /api/projects/:projectRef/lore/search                 hybrid search
POST   /api/projects/:projectRef/lore/remember               propose a candidate update
POST   /api/projects/:projectRef/lore/updates                alias of remember
GET    /api/projects/:projectRef/lore-updates                list updates
GET    /api/lore/updates/:updateId                           read one update
POST   /api/lore/updates/:updateId/validate                  draft → ready
POST   /api/lore/updates/:updateId/publish                   ready → published (409 on conflict)
POST   /api/lore/updates/:updateId/cancel                    reason required
POST   /api/projects/:projectRef/lore/:memoryKey/mark-stale  reason required
POST   /api/projects/:projectRef/lore/:memoryKey/archive     reason required
POST   /api/projects/:projectRef/lore/evidence/check         report local hashes, detect drift
GET    /api/projects/:projectRef/lore-links                  relations
POST   /api/projects/:projectRef/lore-links                  create a relation
DELETE /api/lore-links/:linkId                               remove a relation
POST   /api/projects/:projectRef/context                     compose agent context
GET    /api/projects/:projectRef/context/snapshot            the active core snapshot
```

### Quest

```
GET    /api/projects/:projectRef/quests      list
POST   /api/projects/:projectRef/quests      create
GET    /api/quests/:questId                  detail: Questline, deps, checkpoints, sessions
PATCH  /api/quests/:questId                  update
POST   /api/quests/:questId/archive          completed or cancelled only
POST   /api/quests/:questId/reopen           reason required
POST   /api/quests/:questId/dependencies     add (cycles rejected)
DELETE /api/quests/:questId/dependencies/:dependsOnId
GET    /api/quests/:questId/checkpoints
GET    /api/quests/:questId/sessions
GET    /api/quests/:questId/plan             numbered sub-tasks and their progress
PUT    /api/quests/:questId/plan             declare or re-declare the plan

POST   /api/sessions                         phase one: no Quest, no handoff
GET    /api/sessions/:sessionId
POST   /api/sessions/:sessionId/activate     phase two: classify the first task
POST   /api/sessions/:sessionId/promote      inquiry → real work
POST   /api/sessions/:sessionId/checkpoints  compare-and-swap on the revision
POST   /api/sessions/:sessionId/end          final handoff + clean end + Quest outcome
POST   /api/sessions/:sessionId/heartbeat    durable session liveness
```

#### The plan

`PUT /api/quests/:questId/plan` takes `{ "steps": ["…", "…"] }`. Positions are the numbers, from

1. Re-declaring is allowed mid-Quest so an agent can append to its plan: a step keeps its
   recorded status when its number and title both survive, and anything renamed, inserted or
   reordered starts `pending`. An empty array removes the plan.

Steps are settled through `step_updates` on `POST /api/sessions/:sessionId/checkpoints` — and on
the handoff in `/end` — as `[{ "ordinal": 2, "status": "done" }]`, where `status` defaults to
`done`. They are applied in the checkpoint's own transaction, so a step is never recorded as done
without the checkpoint that says why. An ordinal the plan does not have answers
`QUEST_STEP_NOT_FOUND` rather than being ignored.

#### Closing a Quest

There are two routes, and both are declarations by the agent (ADR-0010, ADR-0011).

**A finished plan closes the Quest**, whatever `next_steps` still says: at least one step, every
step settled, and at least one of them actually `done` rather than `skipped`. This happens at the
checkpoint that settles the last step — mid-session, not only at the end — so the checkpoint
response carries `quest_status`, `quest_status_held` and the `plan`. `quest_plan_sweeper` on the
worker does the same for a Quest whose sessions have all gone, which is what survives a crash.

**`/end` accepts `quest_status`**, the agent's statement of what became of a Quest — the way to
say `blocked` or `cancelled`, or `completed` for a Quest that declared no plan. Nothing is
inferred from the work state: a handoff with no next steps still leaves a planless Quest open,
because stopping is not the same as finishing.

Both routes apply the same two gates to the terminal statuses — `completed` and `cancelled`. The
project must be on `quest_completion_mode: auto`, and no other session may still be attached to
the Quest. Either refusal comes back as `quest_status_held`, naming the reason, with the Quest
untouched and the handoff written as normal; `quest_status` in the response is always the status
the Quest actually holds. A non-terminal status such as `blocked` applies under either mode,
since it closes nothing.

`POST /api/quests/:questId/reopen` is the way back, and takes a required `reason` that lands in
the audit log as `quest.reopened`. Settled plan steps survive a reopen, so a re-declared plan
carries them over. It is not gated on `quest_completion_mode`: the gate exists to stop unwanted
closes, and reopening is the undo.

#### Re-activating a session after its Quest closes

`POST /api/sessions/:sessionId/activate` may be called again once the session's Quest reaches
`completed` or `cancelled`. The new task is classified from scratch, so different work becomes a
new Quest and the session moves onto it; the closed Quest keeps its own checkpoints. This is the
normal shape now that a finished plan closes a Quest mid-session.

It is still refused with `SESSION_STATE_INVALID` while the attached Quest is open, naming the
status in `details.quest_status`. Rebinding live work would strand what is in flight and move
every later checkpoint onto a different Quest.

The asymmetry is deliberate. `completed` and `cancelled` are outside the resumable set, a Quest
named by id after it closes classifies as `new_work` rather than resuming, and no MCP tool
reaches `POST /api/quests/:questId/reopen` — so an unwanted close silently forks the work,
while an unwanted _non_-close costs one click in Guild Hall.

### Party

```
POST   /api/party/runs                             start an agent run
POST   /api/party/runs/:runId/heartbeat            renew the lease (+ claims)
POST   /api/party/runs/:runId/end                  clean end; releases claims
POST   /api/party/runs/:runId/fingerprints         report file hashes
POST   /api/party/claims                           acquire (409 on conflict)
POST   /api/party/claims/:claimId/renew
POST   /api/party/claims/:claimId/release          idempotent
POST   /api/party/claims/:claimId/revoke           confirm + reason + audit
GET    /api/projects/:projectRef/party/status
GET    /api/projects/:projectRef/party/claims
GET    /api/projects/:projectRef/party/runs
```

### Shrine

```
GET    /health/live                          no database access
GET    /health/ready                         database, schema version, configuration
GET    /api/shrine/health                    full health model
GET    /api/shrine/services                  liveness derived from the lease
GET    /api/shrine/jobs                      payloads are summarised, never raw
GET    /api/shrine/jobs/:jobId
POST   /api/shrine/jobs/:jobId/retry         reason required, audited
POST   /api/shrine/jobs/:jobId/cancel        reason required, audited
POST   /api/shrine/jobs/:jobId/requeue       expired-lease jobs only
POST   /api/shrine/jobs/probe                a deterministic no-op probe
GET    /api/shrine/events                    activity feed
GET    /api/events/stream                    SSE, supports Last-Event-ID
GET    /api/shrine/config                    sanitized: never credentials
GET    /api/shrine/schema                    current vs expected version
GET    /api/shrine/metrics-summary
GET    /api/shrine/audit                     administrative actions (admin)
```

---

## Worked examples

**Start a session — note what is _not_ returned**

```http
POST /api/sessions
{ "project": "ERP Backoffice", "client": "claude-code", "agent": "claude" }
```

```json
{
  "session_id": "…",
  "state": "awaiting_task",
  "project": { "id": "…", "name": "ERP Backoffice" },
  "project_revision": 42,
  "core_context": "## Project Overview\n…",
  "bootstrap_required": false,
  "open_quests": [{ "id": "…", "title": "Add CSV report export", "status": "in_progress" }],
  "agent_run_id": "…"
}
```

There is no `continuation` field. Open Quests are _suggestions_; none is attached.

**Activate on the first task**

```http
POST /api/sessions/:sessionId/activate
{ "task": "Add CSV report export", "mode_hint": "auto",
  "scope": { "modules": ["services/api/src/reports"] } }
```

Returns `activation_mode`, the Quest, `context.{core,task,continuation,party,warnings}` and
`related_quests`. `continuation` is non-null only for `resume_work`.

**Checkpoint, and the conflict you must handle**

```http
POST /api/sessions/:sessionId/checkpoints
{ "expected_quest_revision": 4, "kind": "milestone",
  "summary": "Implemented the CSV generator", "work_state": { … } }
```

```json
{
  "error": {
    "code": "QUEST_REVISION_CONFLICT",
    "details": { "expected_revision": 4, "latest_revision": 5, "latest_checkpoint_id": "…" }
  }
}
```

Re-read the latest checkpoint, merge, and resubmit with revision 5.

**A denied claim carries only what you need to coordinate**

```json
{
  "error": {
    "code": "RESOURCE_CLAIM_CONFLICT",
    "details": {
      "resource_type": "migration_sequence",
      "resource_key": "packages/database/migrations",
      "owner_quest_id": "…",
      "owner_quest_title": "Add token-family migration",
      "owner_client": "claude-code",
      "lease_expires_at": "2026-03-01T14:32:00Z"
    }
  }
}
```

No task text, no file contents, nothing about the other agent's work beyond the Quest title.
