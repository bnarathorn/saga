-- Saga 0002 — Lore: durable project knowledge.
--
-- A Lore Entry is a unit of knowledge, not a document chunk. Identity lives in
-- `memory_items`; content lives in immutable `memory_versions`; the item's
-- `current_version_id` is an atomic pointer flipped only by a publish transaction.

-- ---------------------------------------------------------------------------
-- lore.memory_items — stable identity for one durable unit of knowledge.
-- ---------------------------------------------------------------------------
CREATE TABLE lore.memory_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  memory_key         text NOT NULL,
  category           text NOT NULL,
  kind               text NOT NULL,
  state              text NOT NULL DEFAULT 'active',
  importance         integer NOT NULL DEFAULT 50,
  volatility         text NOT NULL DEFAULT 'stable',
  -- Set only by the publish transaction; a FK is added after memory_versions exists.
  current_version_id uuid,
  last_verified_at   timestamptz,
  stale_reason       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT memory_items_key_format CHECK (memory_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  CONSTRAINT memory_items_key_length CHECK (char_length(memory_key) BETWEEN 1 AND 120),
  CONSTRAINT memory_items_category_allowed CHECK (category IN (
    'overview', 'structure', 'coding_style', 'config', 'running', 'deploy', 'debug',
    'logs', 'testing', 'server', 'database', 'api', 'decision', 'warning'
  )),
  CONSTRAINT memory_items_kind_allowed CHECK (kind IN (
    'fact', 'procedure', 'convention', 'map', 'entity', 'decision', 'warning'
  )),
  CONSTRAINT memory_items_state_allowed CHECK (state IN ('active', 'stale', 'archived')),
  CONSTRAINT memory_items_volatility_allowed CHECK (volatility IN ('stable', 'operational')),
  CONSTRAINT memory_items_importance_range CHECK (importance BETWEEN 0 AND 100),
  -- A stale entry must say why; an active one must not carry a stale reason.
  CONSTRAINT memory_items_stale_has_reason
    CHECK ((state = 'stale') = (stale_reason IS NOT NULL)),
  CONSTRAINT memory_items_unique_key UNIQUE (project_id, memory_key)
);

CREATE INDEX memory_items_project_state_idx ON lore.memory_items (project_id, state);
CREATE INDEX memory_items_category_idx ON lore.memory_items (project_id, category, state);
CREATE INDEX memory_items_key_trgm_idx ON lore.memory_items USING gin (memory_key gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- lore.memory_versions — immutable content plus its retrieval representation.
-- ---------------------------------------------------------------------------
CREATE TABLE lore.memory_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_item_id        uuid NOT NULL REFERENCES lore.memory_items(id) ON DELETE CASCADE,
  memory_update_id      uuid,
  base_version_id       uuid REFERENCES lore.memory_versions(id),
  body                  text NOT NULL,
  data                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence              jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash          text NOT NULL,
  confidence            numeric NOT NULL,
  verification_state    text NOT NULL,
  -- The initial embedding profile is fixed at 768 dimensions (ADR-0006). A different
  -- dimension requires a new migration, never a silent truncation.
  embedding             vector(768),
  embedding_state       text NOT NULL DEFAULT 'queued',
  embedding_model       text,
  search_document       tsvector NOT NULL,
  created_by_session_id uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  ready_at              timestamptz,

  CONSTRAINT memory_versions_body_not_blank CHECK (btrim(body) <> ''),
  CONSTRAINT memory_versions_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT memory_versions_verification_allowed
    CHECK (verification_state IN ('observed', 'inferred', 'verified')),
  CONSTRAINT memory_versions_embedding_state_allowed
    CHECK (embedding_state IN ('queued', 'claimed', 'ready', 'failed')),
  CONSTRAINT memory_versions_evidence_is_array CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT memory_versions_data_is_object CHECK (jsonb_typeof(data) = 'object'),
  -- A version that claims a ready embedding must actually carry one.
  CONSTRAINT memory_versions_ready_has_embedding
    CHECK (embedding_state <> 'ready' OR embedding IS NOT NULL)
);

CREATE INDEX memory_versions_item_idx ON lore.memory_versions (memory_item_id, created_at DESC);
CREATE INDEX memory_versions_update_idx ON lore.memory_versions (memory_update_id);
CREATE INDEX memory_versions_search_idx ON lore.memory_versions USING gin (search_document);
CREATE INDEX memory_versions_body_trgm_idx ON lore.memory_versions USING gin (body gin_trgm_ops);
-- Partial: only versions with a usable embedding belong in the vector index.
CREATE INDEX memory_versions_embedding_idx
  ON lore.memory_versions USING hnsw (embedding vector_cosine_ops)
  WHERE embedding_state = 'ready';
CREATE INDEX memory_versions_embedding_queue_idx
  ON lore.memory_versions (embedding_state, created_at)
  WHERE embedding_state IN ('queued', 'failed');

-- The current-version pointer must reference a real version.
ALTER TABLE lore.memory_items
  ADD CONSTRAINT memory_items_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES lore.memory_versions(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- lore.memory_updates — one atomic proposal over one or more Lore Entries.
-- ---------------------------------------------------------------------------
CREATE TABLE lore.memory_updates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  created_by_session_id uuid,
  state                 text NOT NULL DEFAULT 'draft',
  summary               text NOT NULL,
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  validating_at         timestamptz,
  ready_at              timestamptz,
  published_at          timestamptz,
  cancelled_at          timestamptz,
  -- The snapshot prepared while the update was `ready`, activated at publication.
  prepared_snapshot_id  uuid,
  correlation_id        text,

  CONSTRAINT memory_updates_state_allowed CHECK (state IN (
    'draft', 'validating', 'ready', 'published', 'conflict', 'failed', 'cancelled'
  )),
  CONSTRAINT memory_updates_summary_not_blank CHECK (btrim(summary) <> '')
);

CREATE INDEX memory_updates_project_idx ON lore.memory_updates (project_id, created_at DESC);
CREATE INDEX memory_updates_state_idx ON lore.memory_updates (state, created_at);

ALTER TABLE lore.memory_versions
  ADD CONSTRAINT memory_versions_update_fk
  FOREIGN KEY (memory_update_id) REFERENCES lore.memory_updates(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- lore.memory_update_items — item-level optimistic concurrency (ADR-0005).
-- ---------------------------------------------------------------------------
CREATE TABLE lore.memory_update_items (
  memory_update_id     uuid NOT NULL REFERENCES lore.memory_updates(id) ON DELETE CASCADE,
  memory_item_id       uuid NOT NULL REFERENCES lore.memory_items(id) ON DELETE CASCADE,
  -- NULL means "this entry did not exist when the proposal was made".
  base_version_id      uuid REFERENCES lore.memory_versions(id),
  candidate_version_id uuid NOT NULL REFERENCES lore.memory_versions(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_update_id, memory_item_id)
);

CREATE INDEX memory_update_items_item_idx ON lore.memory_update_items (memory_item_id);
CREATE INDEX memory_update_items_candidate_idx
  ON lore.memory_update_items (candidate_version_id);

-- ---------------------------------------------------------------------------
-- lore.memory_links — relationships between knowledge entities.
-- ---------------------------------------------------------------------------
CREATE TABLE lore.memory_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  from_memory_item_id uuid NOT NULL REFERENCES lore.memory_items(id) ON DELETE CASCADE,
  relation            text NOT NULL,
  to_memory_item_id   uuid NOT NULL REFERENCES lore.memory_items(id) ON DELETE CASCADE,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT memory_links_relation_allowed CHECK (relation IN (
    'uses', 'exposes', 'calls', 'depends_on', 'deployed_to',
    'configured_by', 'tested_by', 'logs_to', 'relates_to'
  )),
  CONSTRAINT memory_links_no_self_link CHECK (from_memory_item_id <> to_memory_item_id),
  CONSTRAINT memory_links_unique
    UNIQUE (project_id, from_memory_item_id, relation, to_memory_item_id)
);

CREATE INDEX memory_links_from_idx ON lore.memory_links (from_memory_item_id, relation);
CREATE INDEX memory_links_to_idx ON lore.memory_links (to_memory_item_id, relation);

-- ---------------------------------------------------------------------------
-- lore.context_snapshots — compiled, token-budgeted core context.
-- ---------------------------------------------------------------------------
CREATE TABLE lore.context_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  project_revision bigint NOT NULL,
  state            text NOT NULL DEFAULT 'building',
  sections         jsonb NOT NULL,
  rendered_context text NOT NULL,
  token_count      integer NOT NULL,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ready_at         timestamptz,
  activated_at     timestamptz,

  CONSTRAINT context_snapshots_state_allowed
    CHECK (state IN ('building', 'ready', 'active', 'failed')),
  CONSTRAINT context_snapshots_token_count_non_negative CHECK (token_count >= 0)
);

CREATE INDEX context_snapshots_project_idx ON lore.context_snapshots (project_id, created_at DESC);
-- At most one active snapshot per project: the invariant is enforced by the database, not
-- only by the publish transaction.
CREATE UNIQUE INDEX context_snapshots_one_active_per_project
  ON lore.context_snapshots (project_id)
  WHERE state = 'active';

ALTER TABLE core.projects
  ADD CONSTRAINT projects_active_snapshot_fk
  FOREIGN KEY (active_context_snapshot_id)
  REFERENCES lore.context_snapshots(id) ON DELETE SET NULL;

ALTER TABLE lore.memory_updates
  ADD CONSTRAINT memory_updates_prepared_snapshot_fk
  FOREIGN KEY (prepared_snapshot_id)
  REFERENCES lore.context_snapshots(id) ON DELETE SET NULL;
