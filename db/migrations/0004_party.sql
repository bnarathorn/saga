-- Saga 0004 — Party: live agent coordination.
--
-- Everything here is *leased*. A crashed agent leaves expired rows, never a stuck lock, and
-- nothing in this schema is required for Lore or Quest to work (PARTY_MODE=off).

-- ---------------------------------------------------------------------------
-- party.agent_runs — one live agent process. Not durable session history.
-- ---------------------------------------------------------------------------
CREATE TABLE party.agent_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  session_id        uuid NOT NULL REFERENCES quest.sessions(id) ON DELETE CASCADE,
  work_item_id      uuid REFERENCES quest.work_items(id) ON DELETE SET NULL,
  agent_instance_id text NOT NULL,
  client            text NOT NULL,
  -- Stable hash of machine identity plus canonical project root. Never a path.
  workspace_key     text,
  workspace_label   text,
  state             text NOT NULL DEFAULT 'starting',
  heartbeat_at      timestamptz,
  lease_expires_at  timestamptz,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,

  CONSTRAINT agent_runs_state_allowed
    CHECK (state IN ('starting', 'active', 'waiting', 'ending', 'ended', 'expired')),
  -- A run that is still running must hold a lease; a finished one must not.
  CONSTRAINT agent_runs_live_has_lease
    CHECK (state IN ('ended', 'expired') OR lease_expires_at IS NOT NULL)
);

CREATE INDEX agent_runs_project_idx ON party.agent_runs (project_id, started_at DESC);
CREATE INDEX agent_runs_session_idx ON party.agent_runs (session_id);
CREATE INDEX agent_runs_work_item_idx ON party.agent_runs (work_item_id);
-- The reaper's query: live runs whose lease has lapsed.
CREATE INDEX agent_runs_lease_idx
  ON party.agent_runs (lease_expires_at)
  WHERE state NOT IN ('ended', 'expired');
CREATE INDEX agent_runs_workspace_idx ON party.agent_runs (project_id, workspace_key)
  WHERE state NOT IN ('ended', 'expired');

-- ---------------------------------------------------------------------------
-- party.resources — registry of things that may need coordination.
-- ---------------------------------------------------------------------------
CREATE TABLE party.resources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  resource_type text NOT NULL,
  resource_key  text NOT NULL,
  policy        text NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT resources_policy_allowed CHECK (policy IN ('shared', 'advisory', 'exclusive')),
  CONSTRAINT resources_type_allowed CHECK (resource_type IN (
    'module', 'file', 'database_schema', 'migration_sequence', 'environment', 'service',
    'deployment', 'test_environment', 'service_restart', 'production_config'
  )),
  CONSTRAINT resources_key_not_blank CHECK (btrim(resource_key) <> ''),
  CONSTRAINT resources_unique UNIQUE (project_id, resource_type, resource_key)
);

CREATE INDEX resources_project_idx ON party.resources (project_id, resource_type);

-- ---------------------------------------------------------------------------
-- party.claims — leased ownership or shared use of a coordinated resource.
-- ---------------------------------------------------------------------------
CREATE TABLE party.claims (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id      uuid NOT NULL REFERENCES party.resources(id) ON DELETE CASCADE,
  agent_run_id     uuid NOT NULL REFERENCES party.agent_runs(id) ON DELETE CASCADE,
  work_item_id     uuid NOT NULL REFERENCES quest.work_items(id) ON DELETE CASCADE,
  mode             text NOT NULL,
  state            text NOT NULL DEFAULT 'active',
  base_fingerprint text,
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  released_at      timestamptz,
  release_reason   text,

  CONSTRAINT claims_mode_allowed CHECK (mode IN ('shared', 'exclusive')),
  CONSTRAINT claims_state_allowed CHECK (state IN ('active', 'released', 'expired', 'revoked')),
  CONSTRAINT claims_finished_has_timestamp
    CHECK (state = 'active' OR released_at IS NOT NULL)
);

CREATE INDEX claims_resource_active_idx
  ON party.claims (resource_id, lease_expires_at)
  WHERE state = 'active';
CREATE INDEX claims_agent_run_idx ON party.claims (agent_run_id, state);
CREATE INDEX claims_work_item_idx ON party.claims (work_item_id, state);
CREATE INDEX claims_lease_idx ON party.claims (lease_expires_at) WHERE state = 'active';
-- An exclusive claim is unique per resource while it is active. The acquisition transaction
-- also takes a row lock on the resource, but this index makes the invariant a database fact
-- rather than a promise about application code.
CREATE UNIQUE INDEX claims_one_exclusive_per_resource
  ON party.claims (resource_id)
  WHERE state = 'active' AND mode = 'exclusive';

-- ---------------------------------------------------------------------------
-- party.file_fingerprints — coordination without any version-control system.
-- ---------------------------------------------------------------------------
CREATE TABLE party.file_fingerprints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES quest.work_items(id) ON DELETE CASCADE,
  agent_run_id uuid REFERENCES party.agent_runs(id) ON DELETE SET NULL,
  path         text NOT NULL,
  base_hash    text,
  current_hash text,
  observed_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT file_fingerprints_path_not_blank CHECK (btrim(path) <> ''),
  CONSTRAINT file_fingerprints_unique UNIQUE (work_item_id, path)
);

CREATE INDEX file_fingerprints_project_path_idx ON party.file_fingerprints (project_id, path);
