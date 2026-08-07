# ADR-0011 — A Quest declares its sub-tasks and closes when it has settled them all

- **Status:** accepted
- **Date:** 2026-08-07
- **Amends:** [ADR-0010](0010-quest-completion-is-declared.md), which stays in force

## Context

ADR-0010 gave a Quest exactly one route to `completed` from the agent surface: `quest_status` on
`saga_end_session`, once, at the very end. In practice that route is taken rarely and late. An
agent that stops for any reason other than finishing — context exhausted, a compaction, the user
changing direction, a crash — leaves the Quest `in_progress` for ever, which is precisely the
failure ADR-0010 set out to fix, moved one step along.

The deeper problem is that nothing in a Quest says what finishing it would consist of. A
checkpoint carries a `WorkState`, whose `completed`, `in_progress` and `next_steps` are free-text
arrays rewritten wholesale on every checkpoint. Nothing in them is addressable and nothing in
them is stable, so "is this Quest done?" has no answer any code can read. That is why ADR-0010
had to fall back on a single declaration at the end, and why inferring from `next_steps` was
correctly rejected: an agent records what it would do next as a matter of course, and an
`in_progress` Quest with an empty `next_steps` is a formatting accident rather than a signal.

There is also a race the end-of-session route cannot close on its own. The moment an agent is
most likely to disappear is the moment it has just finished — and a finished Quest that never got
its declaration is indistinguishable, from the outside, from one abandoned halfway.

## Decision

A Quest carries an explicit, numbered **plan**: sub-tasks 1, 2, 3, … declared by the agent, in
`quest.work_item_steps`. Each step is settled individually — `done`, or `skipped` — through
`step_updates` on `saga_checkpoint`, in the same transaction as the checkpoint that settles it.

**A Quest with a finished plan is completed**, whatever `next_steps` still says. Three conditions
define finished, and each rules out a way this could close a Quest that is not done:

- at least one step, so a Quest that never declared a plan is untouched by this route;
- every step settled, so outstanding work holds the Quest open;
- at least one step actually `done`, so an agent that skips its way through a plan — the shape an
  abandoned or misjudged plan takes — does not thereby report success.

`next_steps` is deliberately not consulted. Recording what one would do next is not the same as
the work being unfinished, and treating it as such is what left finished Quests open.

The server closes them too. `quest_plan_sweeper` runs on the worker's five-minute reaper timer
and completes any Quest whose plan is finished and to which no session is attached. This is the
half that survives a crash.

Both routes apply the **same two gates ADR-0010 established**, unchanged:

1. the project must be on `quest_completion_mode = 'auto'`;
2. no other session may still be attached to the Quest.

Both are re-checked under the Quest row lock before anything is written, which is what makes the
sweeper safe without an idle grace period: a Quest picked up between the candidate scan and the
write is seen under the lock and left alone.

Declaring a plan stays **optional**. A Quest with no steps behaves exactly as it did under
ADR-0010 and nothing was backfilled.

## Why this does not contradict ADR-0010

ADR-0010 says a Quest closes because someone said so, never because Saga inferred it. That still
holds. The agent writes the plan, and the agent settles each step by name. Completion here is the
conjunction of N explicit declarations rather than one — more evidence than `quest_status`
carried, not less, and gathered while the agent still had the context to judge each item.

What ADR-0010 actually rejected was reading a work state that was never meant to bear the weight
and drawing a conclusion from it. A step exists to be settled; `next_steps` exists to be read by
the next session. This ADR closes on the former and continues to ignore the latter.

The sweeper is likewise not the time-based reaper ADR-0010 rejected. That proposal closed Quests
on silence, and silence is what a crash and a clean finish look like from outside. This one
closes nothing that a plan someone wrote has not already settled; silence only decides _when_ it
notices.

## Consequences

- Completion happens mid-session, at the checkpoint that settles the last step, not only at the
  end. `saga_checkpoint` therefore returns `quest_status` and `quest_status_held`, and its
  `next_step` tells an agent to stop checkpointing against a Quest that has just closed.
- `quest_status` on `saga_end_session` remains the way to say anything else — `blocked`,
  `cancelled`, or `completed` for a Quest with no plan.
- The risk ADR-0010 identified now has more ways to fire — a wrong close forks the work — so the
  asymmetry that justified the gates is deliberately reduced rather than merely accepted:
  `saga_reopen_quest` gives the agent surface a route back to `POST /api/quests/:questId/reopen`,
  which ADR-0010 recorded as absent. It takes a required reason, lands in the audit log as
  `quest.reopened`, and is **not** gated on `quest_completion_mode`, because the gate exists to
  stop unwanted closes and this is the undo. Settled steps survive a reopen, so the Quest comes
  back knowing what was already done. Projects that still want a person in the loop stay on
  `quest_completion_mode = 'manual'`, where a finished plan surfaces in the console to be
  confirmed; every project predating ADR-0010's migration is already on `manual`.
- A session may activate again once its Quest closes, and the new task is classified from scratch
  — so a further request in the same session becomes a **new Quest** rather than being appended to
  a finished one. This stops being a convenience and becomes necessary here: completion now
  happens mid-session, so the user's next request routinely arrives with the Quest already closed,
  and nothing in the MCP surface can open a second session. Re-activation is still refused while
  the Quest is open, which is the original guard against rebinding work in flight.
- Re-declaring a plan is allowed mid-Quest so an agent can append to it. A step keeps its recorded
  status when its number and title both survive; anything renamed, inserted or reordered starts
  `pending`, so a rewritten plan cannot inherit completions that were never about the new work.
- The continuation an agent reads on resume leads with the plan and names the first unsettled
  step, so resuming is "carry on at step 4" rather than a re-reading of prose.

## Alternatives considered

**Sub-Quests instead of steps.** The parent/child Questline already projects a parent to
`completed` when every child is (`projectParentStatus`). Rejected: a Quest is the unit a session
attaches to, carries checkpoints and holds a revision, and a five-line sub-task is none of those.
Modelling a checklist as five Quests would put five rows on the Quest Board for one piece of work
and give the resume matcher five candidates to confuse.

**Steps as JSONB on `work_items`.** Cheaper by one table. Rejected: settling a step concurrently
with a checkpoint would be a read-modify-write of the whole document, and the sweeper's candidate
scan wants an index on unsettled steps, which a JSONB array does not give without more machinery
than the table costs.

**Closing on all steps done regardless of `quest_completion_mode`.** Rejected: it would change
what agents may do unattended on every project already installed, silently, which is the exact
failure mode ADR-0010's migration went out of its way to avoid.
