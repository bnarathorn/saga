# ADR-0010 — A Quest closes because someone said so, never because Saga inferred it

- **Status:** accepted
- **Date:** 2026-08-07

## Context

Nothing but a person in Guild Hall could move a Quest to `completed`. The only route is
`PATCH /api/quests/:questId`, and no MCP tool calls it. Agents ended sessions, wrote final
handoffs, and left the Quest `in_progress` for ever; `saga_end_session` records the handoff and
deliberately does not touch the Quest's status.

That is not only untidy. `scoreCandidate` (`packages/quest/src/domain/activation.ts`) awards
confidence for `in_progress` and for recent activity, so finished-but-open Quests stay eligible
as resume candidates and crowd out the ones still being worked. Left alone, every project's
activation classification degrades as its history grows.

The obvious cheap fix is to infer completion — close the Quest when the final handoff carries no
`next_steps` and no `blockers`. It is wrong here, and the reason is asymmetry rather than
taste. `completed` and `cancelled` are outside `RESUMABLE`; `classifyActivation` treats a Quest
named by `requested_quest_id` after it closes as unavailable and falls through to `new_work`;
and no MCP tool reaches `POST /api/quests/:questId/reopen`. So an unwanted close silently forks
the work into a second Quest with none of the first one's history, while an unwanted _non_-close
costs one click. Inference also mis-fires in practice: handoffs written before this ADR used
`next_steps` for prose such as "Nothing outstanding", which an empty-array rule reads as
unfinished.

A worker that closed Quests after a period of silence was considered and rejected for the same
reason at one remove: silence is what a crash and a clean finish look like from outside.
`reapStaleSessions` already draws that line, marking a quiet session `abandoned` rather than
completed, and inverting it would report crashes as successes.

## Decision

The agent **declares** the outcome: `saga_end_session` and `POST /api/sessions/:sessionId/end`
take `quest_status`, applied as part of the same handoff. Nothing reads the work state and
concludes anything.

Whether the declaration lands is a per-project policy, `core.projects.quest_completion_mode`,
with the values `auto` and `manual`. It is modelled on `lore_approval_mode` down to the column,
the table and the two values, because it answers the same question for a different domain: may
an agent's word take effect unattended, or does a person confirm it? A server-wide environment
variable was rejected — that would force one policy across every project on a host and need a
restart to change, and `PARTY_MODE` lives there because it is an operational kill-switch, not
project policy.

The gate applies to the terminal statuses only. `completed` and `cancelled` additionally require
that no other session is still attached to the Quest, since Quest-to-session is one-to-many —
`resume_work` and `requested_quest_id` both re-attach — and one agent stopping is not the work
being finished. A non-terminal status such as `blocked` applies under either mode; it ends
nothing and stays inside `RESUMABLE`.

Refusals are reported, not thrown. `quest_status_held` names the reason, `quest_status` reports
what the Quest actually holds, and the session still ends with its handoff intact. An illegal
transition is handled the same way: the checkpoint is already committed by then, and losing a
handoff over a status field would be a poor trade.

New projects default to `auto`. Migration `0007_quest_completion_mode` backfills every existing
project to `manual`, because the default alone would have changed what agents may do on every
installed project, delivered silently by a column nobody reads.

## Consequences

An agent can now finish its own work, and the Quest list stops accumulating rows that are done.
Resume scoring stays meaningful as a project's history grows.

Operators upgrading get no behaviour change until they opt in per project — which also means
they get no benefit until they do. `saga-tools update` will not tell them; the entry under
[Migrations that rewrite data](../operations.md#migrations-that-rewrite-data) is where they find
out.

Guild Hall displays the mode on Project Detail but does not edit it; `PATCH /api/projects/:ref`
is the only way to change it, exactly as with `lore_approval_mode`. If that becomes a friction
point, an editor on the project settings screen is the obvious follow-up.

Reopening remains human-only. That is a deliberate asymmetry — an agent may finish work but not
un-finish it — and it is the thing to revisit first if wrongly closed Quests turn out to be
common in practice.
