# Saga — Agent Integration

How Codex, Claude Code and other agents use Saga, and the policy they should follow.

---

## 1. Setup

`saga` is not published to any registry — it is the Saga repository's `apps/cli` workspace
package, whose `bin` entry points at a compiled `dist/main.js`. From inside the Saga
repository, build it once and link it onto your `PATH`:

```bash
pnpm --filter @saga/cli build
pnpm -C apps/cli link --global
```

(If pnpm reports `ERR_PNPM_NO_GLOBAL_BIN_DIR`, it has no global bin directory configured yet;
run `pnpm setup` once, open a new shell, and repeat the `link` command above.)

With `saga` on `PATH`, move to the project you want Saga to manage — not the Saga repository
itself, since `saga connect` binds whatever directory it is run from — and connect it:

```bash
cd /path/to/your/project      # plain folder, Git without a remote, or SVN — all fine
saga connect
```

`saga connect` does the whole flow: finds the server, authorizes this machine through the
browser device flow, detects the project root, binds the folder to a project, reports whether
Lore bootstrap is required, and writes MCP configuration.

It writes two files:

| File                                                 | For         | Scope                                                      |
| ---------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| `.mcp.json` at the project root                      | Claude Code | project-local                                              |
| `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` | Codex       | user-global (Codex has no project-level MCP configuration) |

Claude Code reads JSON:

```json
{
  "mcpServers": {
    "saga": {
      "command": "saga",
      "args": ["mcp"],
      "env": { "SAGA_SERVER_URL": "https://saga.example.internal", "SAGA_PROJECT": "…" }
    }
  }
}
```

Codex reads TOML, and only from its own home — a `.codex/config.json` beside the code is never
opened. The entry is appended, and an entry that already exists is left exactly as it is:

```toml
[mcp_servers.saga]
command = "saga"
args = ["mcp"]

[mcp_servers.saga.env]
SAGA_SERVER_URL = "https://saga.example.internal"
SAGA_PROJECT = "…"
```

`codex mcp list` is the quickest confirmation that Codex can see it. Because that file is
user-global, a machine hosting several Saga projects points Codex at one of them; per-project
work is what `.mcp.json` and Claude Code give you.

**No token is written here.** The MCP server reads the credential from the operating-system
keychain, or from `SAGA_TOKEN` in CI.

Verify with `saga doctor`. It exits non-zero only for real failures, so it is safe in CI.

### Staying current

```bash
saga update           # install the build this server is serving
saga update --check   # report what is available, install nothing
```

The server serves the CLI that was built with it, so `saga update` is how a client picks up a
server upgrade: it downloads `GET /api/cli/saga`, replaces the file the command is running
from, and runs the result before keeping it. A download that is not a CLI build is refused, and
a build that does not run is rolled back — so the command cannot leave a machine without the
command that would fix it.

"Am I already running this build?" is answered by a SHA-256 digest of the bytes, which the
route sends as `x-saga-cli-build` and the CLI computes over the file it is running from. The
version cannot answer it: Saga is pre-1.0 and every build stamps the same `0.1.0`, so a client
comparing versions reported itself current against a bundle that shared nothing with it but
the number. Builds carry that number plus an identifier for the build itself —
`0.1.0+gab12cd34ef.20260806103012`, the commit and its timestamp — which is semver build
metadata and so changes nothing about compatibility. Against a server too old to send a
digest, the version comparison is still the fallback.

It needs no token; the endpoint is public. If the CLI lives somewhere the user cannot write —
`/usr/local/bin`, say — the command says so and changes nothing, and elevated privileges or a
per-user install (`~/.local/bin/saga`) are the two ways forward.

---

## 2. The integration policy

This is what an agent should do. It reaches the agent twice: the MCP server returns it as
`instructions` from `initialize`, which a host puts in front of the model before it starts
work, and each step is repeated in the description of the tool that performs it.

Tool descriptions alone are not enough. A description is read when the agent is already looking
for a tool to call, so nothing in it can prompt the agent to act _before_ it starts — which is
how a folder ends up bound, authorised, healthy and still absent from Guild Hall.

**When starting**

1. Call `saga_start_session`.
2. Read the returned Core Context.

Saga does not depend on step 1 to know an agent is here: the session and its agent run are
opened when the client finishes `initialize`, so Party is correct even for an agent that
ignores this policy entirely. `saga_start_session` returns that session rather than a second
one; its job is to hand the agent its Core Context.

**After receiving the first user task**

3. Call `saga_activate_task` with the task verbatim, and the scope you expect to touch.
4. Use the returned Task and Continuation context **before editing any file**.

**During work**

5. Create checkpoints at milestones and before context compaction.
6. Use `saga_remember` only for durable project knowledge.
7. Claim critical shared resources before risky operations.
8. Refresh context when the project or parallel work changes materially.

**Before ending**

9. Create a final handoff.
10. Call `saga_end_session`.

---

## 3. Tools

| Tool                  | Purpose                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `saga_start_session`  | Open a session. Returns short Core Context and bootstrap state. **Attaches no Quest and loads no handoff.** |
| `saga_activate_task`  | Report the first task. Saga classifies it and returns the right context.                                    |
| `saga_get_context`    | Refresh context, with the current memory revision and stale-Lore warnings.                                  |
| `saga_search_lore`    | Search durable knowledge instead of re-reading the repository.                                              |
| `saga_checkpoint`     | Record progress. Compare-and-swap on the Quest revision.                                                    |
| `saga_remember`       | Propose Lore Entries. Creates a candidate; never overwrites.                                                |
| `saga_claim_resource` | Claim a resource before a risky or exclusive operation.                                                     |
| `saga_release_claim`  | Release as soon as the protected operation finishes. Idempotent.                                            |
| `saga_end_session`    | Final handoff, end the session and the agent run, release claims.                                           |

### Why session startup is two-phase

`saga_start_session` deliberately does **not** load a handoff. At that moment Saga does not
know what the user is about to ask. Loading the most recent handoff would mean a session
opened to fix an unrelated bug starts with someone else's half-finished refactor in context.

`saga_activate_task` is where the decision is made:

| Mode          | When                                                   | What you get                          |
| ------------- | ------------------------------------------------------ | ------------------------------------- |
| `new_work`    | a new task                                             | Core + Task context, and a new Quest  |
| `resume_work` | the user explicitly continues, and the match is strong | Core + Task + Continuation            |
| `inquiry`     | a question or exploration                              | Core + Task context, and **no Quest** |

Auto-resume needs _both_ explicit continuation intent ("continue", "resume", "where we left
off", or a named Quest) _and_ a strong match. Otherwise Saga creates new work and returns
near-matches in `related_quests` for you to offer the user.

If an inquiry session starts changing files, promote it — `saga_activate_task` again with
`mode_hint: "new_work"`.

---

## 4. Checkpoints

Record one when:

- a meaningful milestone is reached
- context compaction is about to occur
- an important test completes
- a risky or exclusive operation is about to begin
- the Quest becomes blocked or waiting
- the session is about to end

The `work_state` structure is what the next session actually reads:

```json
{
  "goal": "Add refresh-token reuse detection",
  "completed": ["Added the token-family schema"],
  "in_progress": ["Integration test"],
  "next_steps": ["Apply the migration to the test database"],
  "blockers": [
    {
      "description": "The test database schema is behind",
      "suggested_action": "Run the test migration"
    }
  ],
  "decisions": [
    {
      "decision": "Revoke the entire token family",
      "reason": "This prevents replay after token theft"
    }
  ],
  "changed_files": [
    {
      "path": "services/api/src/auth/refresh-token.ts",
      "base_hash": "sha256:aaa",
      "current_hash": "sha256:bbb"
    }
  ],
  "commands": [
    {
      "command": "pnpm test:integration",
      "status": "failed",
      "summary": "The token_family_id column is missing"
    }
  ],
  "tests": [{ "name": "authentication integration tests", "status": "blocked" }]
}
```

Write it for the agent that picks this up tomorrow with none of your context. `next_steps` and
`blockers` are what they will read first.

### Handling a revision conflict

```json
{
  "error": "QUEST_REVISION_CONFLICT",
  "details": { "expected_revision": 4, "latest_revision": 5 },
  "what_to_do": "Another session recorded a checkpoint first. Re-read the Quest, merge your work state with the latest checkpoint, and submit again with the new revision. Do not retry blindly."
}
```

Do exactly that. Retrying with the same body would discard whatever the other session recorded.

---

## 5. Recording knowledge

`saga_remember` is for knowledge that stays true beyond the current task:

- what the project is and how it is laid out
- conventions the linter actually enforces
- how to run, test, deploy, debug and read logs
- servers, databases, APIs and their operational constraints
- decisions and their rationale
- warnings and hazards

It is **not** for transient task state (that is a checkpoint) and **never** for credentials.
Candidates containing a secret are rejected with the field path that tripped the policy; the
value is never echoed back. Replace it with a placeholder or an environment-variable
reference — documenting _which_ variables exist is welcome, documenting their values is not.

Mark anything you concluded rather than read as `verification_state: "inferred"` with lower
confidence, and attach `evidence` paths and content hashes wherever you can. Evidence is what
lets Saga notice later that an entry has gone stale.

---

## 6. Coordination

Claim before a risky or exclusive operation:

```text
migration_sequence   test_environment   deployment
service_restart      production_config
```

These are **fail-closed**: if the claim is refused, or coordination is unavailable, do not
proceed. Record a checkpoint describing the waiting state and what is required.

Module and file claims are advisory: you will be told about an overlap, and you should
coordinate through the Quest rather than stop.

Report file fingerprints so Saga can warn when another Quest has already changed a file you
based your work on. This works with no version control at all.

---

## 7. Bootstrap

When a project has no active core context, session startup returns `bootstrap_required: true`
and a plan naming the paths worth inspecting, the paths to avoid, and the Lore keys to
propose.

Rules, which the plan repeats:

- Never invent a command, endpoint, server, database or deployment procedure.
- Mark inferred facts as `inferred`, with lower confidence than what you read.
- Include evidence path and content hash whenever possible.
- Do not read excluded files or anything that looks like a secret.
- Split long knowledge into several entries rather than one long document.

Bootstrap is incremental. A small, coherent, validated set of entries now is better than a
large speculative one.

---

## 8. Without MCP

`@saga/agent-sdk` is a typed client for other integrations:

```ts
import { SagaClient } from '@saga/agent-sdk';

const saga = new SagaClient({ baseUrl, token: process.env.SAGA_TOKEN!, client: 'my-agent' });
const session = await saga.startSession({ project: 'ERP Backoffice', client: 'my-agent' });
const activated = await saga.activateSession(session.session_id, { task });
```

It retries transient failures with backoff and **never** retries a conflict: a
`QUEST_REVISION_CONFLICT` is rethrown for you to handle, because swallowing it would discard
work. `RETRY_GUIDANCE` exports the same wording the MCP tools return.
