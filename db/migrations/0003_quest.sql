-- Saga 0003 — Quest: durable work continuity.
--
-- A Quest outlives any single agent session. Sessions are durable history; checkpoints are
-- append-only; the live process state lives in Party (0005), never here.

-- ---------------------------------------------------------------------------
-- quest.work_items — one unit of work, spanning any number of sessions.
-- ---------------------------------------------------------------------------
CREATE TABLE quest.work_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  parent_work_item_id   uuid REFERENCES quest.work_items(id) ON DELETE SET NULL,
  title                 text NOT NULL,
  objective             text,
  status                text NOT NULL DEFAULT 'open',
  priority              text NOT NULL DEFAULT 'normal',
  scope                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Compare-and-swap counter for checkpoint creation.
  revision              bigint NOT NULL DEFAULT 0,
  latest_checkpoint_id  uuid,
  created_by_session_id uuid,
  -- Set when a human deliberately chose the status, so parent-state projection
  -- does not silently overwrite it.
  status_set_manually   boolean NOT NULL DEFAULT false,
  embedding             vector(768),
  embedding_state       text NOT NULL DEFAULT 'queued',
  search_document       tsvector NOT NULL DEFAULT ''::tsvector,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_activity_at      timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  archived_at           timestamptz,

  CONSTRAINT work_items_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT work_items_status_allowed CHECK (status IN (
    'open', 'in_progress', 'waiting', 'blocked', 'completed', 'cancelled'
  )),
  CONSTRAINT work_items_priority_allowed
    CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  CONSTRAINT work_items_scope_is_object CHECK (jsonb_typeof(scope) = 'object'),
  CONSTRAINT work_items_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT work_items_no_self_parent CHECK (parent_work_item_id <> id),
  CONSTRAINT work_items_embedding_state_allowed
    CHECK (embedding_state IN ('queued', 'claimed', 'ready', 'failed'))
);

CREATE INDEX work_items_project_status_idx
  ON quest.work_items (project_id, status, last_activity_at DESC);
CREATE INDEX work_items_parent_idx ON quest.work_items (parent_work_item_id);
CREATE INDEX work_items_open_idx
  ON quest.work_items (project_id, last_activity_at DESC)
  WHERE status NOT IN ('completed', 'cancelled') AND archived_at IS NULL;
CREATE INDEX work_items_search_idx ON quest.work_items USING gin (search_document);
CREATE INDEX work_items_title_trgm_idx ON quest.work_items USING gin (title gin_trgm_ops);
CREATE INDEX work_items_embedding_idx
  ON quest.work_items USING hnsw (embedding vector_cosine_ops)
  WHERE embedding_state = 'ready';

-- ---------------------------------------------------------------------------
-- quest.work_item_dependencies
-- ---------------------------------------------------------------------------
CREATE TABLE quest.work_item_dependencies (
  work_item_id            uuid NOT NULL REFERENCES quest.work_items(id) ON DELETE CASCADE,
  depends_on_work_item_id uuid NOT NULL REFERENCES quest.work_items(id) ON DELETE CASCADE,
  dependency_type         text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (work_item_id, depends_on_work_item_id),
  CONSTRAINT dependencies_no_self CHECK (work_item_id <> depends_on_work_item_id),
  CONSTRAINT dependencies_type_allowed
    CHECK (dependency_type IN ('blocks', 'requires_output', 'must_complete_before'))
);

CREATE INDEX dependencies_depends_on_idx
  ON quest.work_item_dependencies (depends_on_work_item_id);

-- ---------------------------------------------------------------------------
-- quest.sessions — durable history of an agent's period of work.
--
-- Deliberately separate from party.agent_runs: a session survives a crashed process, and
-- one session may be served by several agent runs.
-- ---------------------------------------------------------------------------
CREATE TABLE quest.sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  work_item_id            uuid REFERENCES quest.work_items(id) ON DELETE SET NULL,
  client                  text NOT NULL,
  agent                   text,
  state                   text NOT NULL DEFAULT 'awaiting_task',
  activation_mode         text,
  initial_task            text,
  started_memory_revision bigint NOT NULL,
  workspace_key           text,
  workspace_label         text,
  started_at              timestamptz NOT NULL DEFAULT now(),
  activated_at            timestamptz,
  last_seen_at            timestamptz,
  ended_at                timestamptz,

  CONSTRAINT sessions_state_allowed
    CHECK (state IN ('awaiting_task', 'active', 'completed', 'abandoned')),
  CONSTRAINT sessions_activation_mode_allowed
    CHECK (activation_mode IS NULL OR activation_mode IN ('new_work', 'resume_work', 'inquiry')),
  -- A session that has been activated must say how; one awaiting a task must not.
  CONSTRAINT sessions_awaiting_has_no_mode
    CHECK (state <> 'awaiting_task' OR (activation_mode IS NULL AND work_item_id IS NULL)),
  -- Inquiry sessions deliberately have no Quest until they are promoted.
  CONSTRAINT sessions_active_has_mode CHECK (state <> 'active' OR activation_mode IS NOT NULL)
);

CREATE INDEX sessions_project_idx ON quest.sessions (project_id, started_at DESC);
CREATE INDEX sessions_work_item_idx ON quest.sessions (work_item_id, started_at DESC);
CREATE INDEX sessions_open_idx
  ON quest.sessions (last_seen_at)
  WHERE state IN ('awaiting_task', 'active');

-- ---------------------------------------------------------------------------
-- quest.checkpoints — append-only progress records and handoffs.
-- ---------------------------------------------------------------------------
CREATE TABLE quest.checkpoints (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id              uuid NOT NULL REFERENCES quest.sessions(id) ON DELETE CASCADE,
  work_item_id            uuid NOT NULL REFERENCES quest.work_items(id) ON DELETE CASCADE,
  -- The Quest revision the author had observed; publication is a compare-and-swap on it.
  base_work_item_revision bigint NOT NULL,
  sequence                integer NOT NULL,
  kind                    text NOT NULL,
  summary                 text NOT NULL,
  work_state              jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT checkpoints_kind_allowed
    CHECK (kind IN ('automatic', 'milestone', 'final_handoff')),
  CONSTRAINT checkpoints_summary_not_blank CHECK (btrim(summary) <> ''),
  CONSTRAINT checkpoints_work_state_is_object CHECK (jsonb_typeof(work_state) = 'object'),
  CONSTRAINT checkpoints_sequence_positive CHECK (sequence > 0),
  CONSTRAINT checkpoints_session_sequence_uniq UNIQUE (session_id, sequence)
);

CREATE INDEX checkpoints_work_item_idx
  ON quest.checkpoints (work_item_id, created_at DESC, sequence DESC);
CREATE INDEX checkpoints_session_idx ON quest.checkpoints (session_id, sequence);
-- Fast lookup of the most recent final handoff for a Quest.
CREATE INDEX checkpoints_handoff_idx
  ON quest.checkpoints (work_item_id, created_at DESC)
  WHERE kind = 'final_handoff';

ALTER TABLE quest.work_items
  ADD CONSTRAINT work_items_latest_checkpoint_fk
  FOREIGN KEY (latest_checkpoint_id) REFERENCES quest.checkpoints(id) ON DELETE SET NULL;

ALTER TABLE quest.work_items
  ADD CONSTRAINT work_items_created_by_session_fk
  FOREIGN KEY (created_by_session_id) REFERENCES quest.sessions(id) ON DELETE SET NULL;

ALTER TABLE lore.memory_versions
  ADD CONSTRAINT memory_versions_session_fk
  FOREIGN KEY (created_by_session_id) REFERENCES quest.sessions(id) ON DELETE SET NULL;

ALTER TABLE lore.memory_updates
  ADD CONSTRAINT memory_updates_session_fk
  FOREIGN KEY (created_by_session_id) REFERENCES quest.sessions(id) ON DELETE SET NULL;
