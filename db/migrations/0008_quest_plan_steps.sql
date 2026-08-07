-- Saga 0008 — an explicit, numbered plan on a Quest.
--
-- Until now a Quest carried a `work_state` per checkpoint and nothing else: `completed`,
-- `in_progress` and `next_steps` were free-text arrays rewritten wholesale on every checkpoint.
-- Nothing in them is addressable, so "is this Quest finished?" had no answer the server could
-- read — only a status an agent declared at the very end, or a person set in Guild Hall.
--
-- A plan is different in kind from a work state. It is declared once, numbered 1..N, and each
-- item is settled individually and permanently. That makes completion checkable: every step
-- settled, at least one of them actually done, and the Quest is finished whatever `next_steps`
-- still says. See ADR-0011.
--
-- A plan stays optional. A Quest with no steps behaves exactly as it did before this migration:
-- it closes when someone declares it closed, and nothing else. Nothing is backfilled.

CREATE TABLE quest.work_item_steps (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id               uuid NOT NULL REFERENCES quest.work_items(id) ON DELETE CASCADE,
  -- 1-based and contiguous, so an agent addresses a step by the number it read.
  ordinal                    integer NOT NULL,
  title                      text NOT NULL,
  status                     text NOT NULL DEFAULT 'pending',
  -- Which session and checkpoint settled the step. Both survive their process, and both are
  -- cleared rather than cascading: losing the provenance must never delete the step itself.
  completed_at               timestamptz,
  completed_by_session_id    uuid REFERENCES quest.sessions(id) ON DELETE SET NULL,
  completed_by_checkpoint_id uuid REFERENCES quest.checkpoints(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT work_item_steps_ordinal_positive CHECK (ordinal > 0),
  CONSTRAINT work_item_steps_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT work_item_steps_status_allowed
    CHECK (status IN ('pending', 'in_progress', 'done', 'skipped')),
  -- A settled step always carries when it settled, and an unsettled one never does: the
  -- sweeper reads status and Guild Hall reads the timestamp, and they must not disagree.
  CONSTRAINT work_item_steps_settled_has_time
    CHECK ((status IN ('done', 'skipped')) = (completed_at IS NOT NULL)),
  CONSTRAINT work_item_steps_ordinal_uniq UNIQUE (work_item_id, ordinal)
);

-- Every read of a plan is "all steps of one Quest, in order".
CREATE INDEX work_item_steps_work_item_idx
  ON quest.work_item_steps (work_item_id, ordinal);

-- The sweeper's candidate scan: Quests that still have an unsettled step are the ones it must
-- skip, so index exactly those rows rather than the whole table.
CREATE INDEX work_item_steps_unsettled_idx
  ON quest.work_item_steps (work_item_id)
  WHERE status NOT IN ('done', 'skipped');
