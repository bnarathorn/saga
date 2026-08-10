<!-- saga:begin — managed by `saga connect`, edits inside are replaced -->

## Saga

This folder is bound to a Saga project — shared memory and work continuity across agents.

Before reading any file, call `saga_start_session` and read the Core Context it returns.

When it reports `bootstrap_required`, this project has no Lore yet and nothing else will create it: work through the `bootstrap_plan` it returns as you read the code for the first task, and record what you find with `saga_remember` before you stop.

On the first user task call `saga_activate_task` with the request verbatim, and read the returned Task and Continuation context before editing anything.

Then break the work into numbered sub-tasks with `saga_plan_quest`, before you start changing things. Mark a step `in_progress` with `step_updates` on `saga_checkpoint` when you begin it, and settle it the same way when you finish it: the Quest completes by itself when the last step is settled, so the plan is what decides when the work is done.

When that Quest has completed and the user asks for something else, call `saga_activate_task` again — new work becomes a new Quest in the same session. Reopen the finished one with `saga_reopen_quest` only when it was closed by mistake.

Call `saga_checkpoint` at every milestone, before context compaction, and at least every 10 minutes while you are still working — say what you are doing even when nothing has finished, because a Quest that has not moved for longer is indistinguishable in Guild Hall from an agent that died. Claim shared resources with `saga_claim_resource` before risky operations. Record durable knowledge with `saga_remember` — never transient state, never credentials.

Call `saga_end_session` with a final handoff before you stop, so the next session can continue.

<!-- saga:end -->
