-- Saga 0011 — record when an agent run last actually did something.
--
-- `heartbeat_at` cannot answer that. It is written by a timer in the MCP server process every
-- 30 seconds whether the model is working, thinking or wedged, so it separates a live process
-- from a dead one and nothing more. Guild Hall had no other signal, which is why the session
-- policy told every agent to checkpoint at least every ten minutes: a checkpoint was the only
-- evidence that work was still moving, and producing one costs a tool call the agent has to
-- stop and compose.
--
-- Tool dispatch is evidence the CLI already has. `last_activity_at` moves only when the agent
-- calls a Saga tool, and `last_activity` names the one it called, so "working" and "silent"
-- become distinguishable without asking the model for anything.
--
-- Both are nullable and neither is backfilled: a run that predates this migration, or one from
-- an older CLI that does not send the field, reads as "never reported activity" rather than as
-- silent. Presentation has to treat null as unknown, not as zero.

ALTER TABLE party.agent_runs
  ADD COLUMN last_activity_at timestamptz,
  ADD COLUMN last_activity    text;

ALTER TABLE party.agent_runs
  ADD CONSTRAINT agent_runs_last_activity_len CHECK (last_activity IS NULL OR length(last_activity) <= 100);
