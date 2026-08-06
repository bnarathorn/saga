-- Saga 0007 — per-project policy for who may close a Quest.
--
-- Until now nothing but a person in Guild Hall could move a Quest to `completed`: the only
-- route is PATCH /api/quests/:questId, and no MCP tool calls it. Sessions ended, final
-- handoffs were recorded, and the Quest stayed `in_progress` for ever.
--
-- That is not merely untidy. `scoreCandidate` (packages/quest/src/domain/activation.ts) awards
-- confidence for `in_progress` and for recent activity, so finished-but-open Quests stay
-- eligible as resume candidates and crowd out the ones still being worked.
--
-- Modelled on `lore_approval_mode`, which answers the same question for Lore: may an agent's
-- proposal take effect by itself, or does it wait for a person? Same two values, same table,
-- so there is one place to look for "what may an agent do here unattended".
--
-- New projects default to `auto`. Existing rows are backfilled to `manual` deliberately: the
-- default alone would change what agents are allowed to do on every project already installed,
-- delivered silently by a column default nobody reads. Turning it on is a decision an operator
-- makes per project, with PATCH /api/projects/:projectRef.

ALTER TABLE core.projects
  ADD COLUMN quest_completion_mode text NOT NULL DEFAULT 'auto';

-- Only rows that predate the column; anything created afterwards takes the default.
UPDATE core.projects SET quest_completion_mode = 'manual';

ALTER TABLE core.projects
  ADD CONSTRAINT projects_quest_completion_mode_allowed
  CHECK (quest_completion_mode IN ('auto', 'manual'));
