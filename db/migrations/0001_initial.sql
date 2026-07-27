-- Saga 0001 — foundation: extensions, schemas, project identity, security, Shrine.
--
-- Naming: database objects use plain technical names (projects, jobs, agent_runs); the
-- product vocabulary (Lore, Quest, Party, Shrine) lives in the schema names and in the UI.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS lore;
CREATE SCHEMA IF NOT EXISTS quest;
CREATE SCHEMA IF NOT EXISTS party;
CREATE SCHEMA IF NOT EXISTS shrine;
CREATE SCHEMA IF NOT EXISTS security;

-- ---------------------------------------------------------------------------
-- core.projects — the primary namespace. Identity is the UUID; the name is a label.
-- ---------------------------------------------------------------------------
CREATE TABLE core.projects (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                       text NOT NULL,
  -- Canonical normalization (NFKC + trim + whitespace collapse + case fold) is applied in
  -- @saga/core/normalization before insert, so equivalent-looking names collide here.
  name_key                   text NOT NULL,
  description                text,
  status                     text NOT NULL DEFAULT 'active',
  memory_revision            bigint NOT NULL DEFAULT 0,
  active_context_snapshot_id uuid,
  lore_approval_mode         text NOT NULL DEFAULT 'auto',
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT projects_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT projects_name_key_not_blank CHECK (btrim(name_key) <> ''),
  CONSTRAINT projects_status_allowed CHECK (status IN ('active', 'archived')),
  CONSTRAINT projects_approval_mode_allowed CHECK (lore_approval_mode IN ('auto', 'manual')),
  CONSTRAINT projects_memory_revision_non_negative CHECK (memory_revision >= 0)
);

CREATE UNIQUE INDEX projects_name_key_uniq ON core.projects (name_key);
CREATE INDEX projects_status_idx ON core.projects (status, updated_at DESC);
CREATE INDEX projects_name_trgm_idx ON core.projects USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- core.project_aliases — previous names stay resolvable forever after a rename.
-- ---------------------------------------------------------------------------
CREATE TABLE core.project_aliases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  alias      text NOT NULL,
  alias_key  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT project_aliases_not_blank CHECK (btrim(alias) <> '')
);

CREATE UNIQUE INDEX project_aliases_alias_key_uniq ON core.project_aliases (alias_key);
CREATE INDEX project_aliases_project_idx ON core.project_aliases (project_id);

-- ---------------------------------------------------------------------------
-- core.outbox_events — written in the same transaction as the mutation that caused them.
-- ---------------------------------------------------------------------------
CREATE TABLE core.outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id   uuid,
  topic          text NOT NULL,
  payload        jsonb NOT NULL,
  state          text NOT NULL DEFAULT 'pending',
  attempts       integer NOT NULL DEFAULT 0,
  available_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  last_error     text,
  correlation_id text,
  project_id     uuid REFERENCES core.projects(id) ON DELETE CASCADE,

  CONSTRAINT outbox_state_allowed
    CHECK (state IN ('pending', 'processing', 'published', 'failed')),
  CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
);

-- Partial index: the claim query only ever looks at deliverable rows.
CREATE INDEX outbox_pending_idx
  ON core.outbox_events (available_at, created_at)
  WHERE state IN ('pending', 'processing');
CREATE INDEX outbox_topic_idx ON core.outbox_events (topic, created_at DESC);

-- ---------------------------------------------------------------------------
-- core.idempotency_records — persisted replay protection for retryable mutations.
-- ---------------------------------------------------------------------------
CREATE TABLE core.idempotency_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_key       text NOT NULL,
  operation       text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,
  state           text NOT NULL DEFAULT 'in_progress',
  response_status integer,
  response_body   jsonb,
  resource_id     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,

  CONSTRAINT idempotency_state_allowed CHECK (state IN ('in_progress', 'completed'))
);

CREATE UNIQUE INDEX idempotency_lookup_uniq
  ON core.idempotency_records (actor_key, operation, idempotency_key);
CREATE INDEX idempotency_expiry_idx ON core.idempotency_records (expires_at);

-- ---------------------------------------------------------------------------
-- security.users
-- ---------------------------------------------------------------------------
CREATE TABLE security.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  email_key           text NOT NULL,
  display_name        text NOT NULL,
  password_hash       text NOT NULL,
  role                text NOT NULL DEFAULT 'viewer',
  state               text NOT NULL DEFAULT 'active',
  failed_attempts     integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_role_allowed CHECK (role IN ('admin', 'operator', 'viewer')),
  CONSTRAINT users_state_allowed CHECK (state IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX users_email_key_uniq ON security.users (email_key);

-- ---------------------------------------------------------------------------
-- security.web_sessions — opaque, server-side, revocable. Only the hash is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE security.web_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES security.users(id) ON DELETE CASCADE,
  session_hash    text NOT NULL,
  csrf_token_hash text NOT NULL,
  user_agent      text,
  ip_address      inet,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz
);

CREATE UNIQUE INDEX web_sessions_hash_uniq ON security.web_sessions (session_hash);
CREATE INDEX web_sessions_user_idx ON security.web_sessions (user_id, expires_at DESC);

-- ---------------------------------------------------------------------------
-- security.agent_tokens — always project-scoped, always hashed.
-- ---------------------------------------------------------------------------
CREATE TABLE security.agent_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES core.projects(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES security.users(id) ON DELETE SET NULL,
  name          text NOT NULL,
  token_hash    text NOT NULL,
  token_prefix  text NOT NULL,
  scopes        text[] NOT NULL,
  client        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES security.users(id) ON DELETE SET NULL,

  CONSTRAINT agent_tokens_scopes_not_empty CHECK (cardinality(scopes) > 0)
);

CREATE UNIQUE INDEX agent_tokens_hash_uniq ON security.agent_tokens (token_hash);
CREATE INDEX agent_tokens_project_idx ON security.agent_tokens (project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- security.device_codes — CLI browser-approval flow. Single-use and short-lived.
-- ---------------------------------------------------------------------------
CREATE TABLE security.device_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL,
  user_code       text NOT NULL,
  client          text NOT NULL,
  requested_scopes text[] NOT NULL,
  workspace_label text,
  state           text NOT NULL DEFAULT 'pending',
  project_id      uuid REFERENCES core.projects(id) ON DELETE CASCADE,
  approved_by     uuid REFERENCES security.users(id) ON DELETE SET NULL,
  agent_token_id  uuid REFERENCES security.agent_tokens(id) ON DELETE SET NULL,
  issued_token    text,
  poll_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  consumed_at     timestamptz,
  expires_at      timestamptz NOT NULL,

  CONSTRAINT device_codes_state_allowed
    CHECK (state IN ('pending', 'approved', 'consumed', 'denied', 'expired'))
);

CREATE UNIQUE INDEX device_codes_hash_uniq ON security.device_codes (device_code_hash);
CREATE UNIQUE INDEX device_codes_user_code_uniq ON security.device_codes (user_code);
CREATE INDEX device_codes_expiry_idx ON security.device_codes (expires_at);

-- ---------------------------------------------------------------------------
-- security.audit_logs — every administrative mutation.
-- ---------------------------------------------------------------------------
CREATE TABLE security.audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type  text NOT NULL,
  actor_id    uuid,
  actor_label text,
  action      text NOT NULL,
  project_id  uuid REFERENCES core.projects(id) ON DELETE SET NULL,
  entity_type text,
  entity_id   uuid,
  reason      text,
  request_id  text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_actor_type_allowed CHECK (actor_type IN ('user', 'agent', 'system'))
);

CREATE INDEX audit_logs_created_idx ON security.audit_logs (created_at DESC);
CREATE INDEX audit_logs_project_idx ON security.audit_logs (project_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON security.audit_logs (action, created_at DESC);

-- ---------------------------------------------------------------------------
-- shrine.service_instances — liveness is derived from lease_expires_at, not from `state`.
-- ---------------------------------------------------------------------------
CREATE TABLE shrine.service_instances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role             text NOT NULL,
  instance_key     text NOT NULL,
  version          text NOT NULL,
  hostname         text,
  process_id       integer,
  state            text NOT NULL DEFAULT 'starting',
  started_at       timestamptz NOT NULL DEFAULT now(),
  heartbeat_at     timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT service_role_allowed CHECK (role IN ('api', 'worker', 'scheduler')),
  CONSTRAINT service_state_allowed
    CHECK (state IN ('starting', 'running', 'draining', 'stopped'))
);

CREATE UNIQUE INDEX service_instances_key_uniq ON shrine.service_instances (role, instance_key);
CREATE INDEX service_instances_lease_idx ON shrine.service_instances (lease_expires_at DESC);

-- ---------------------------------------------------------------------------
-- shrine.jobs — generic leased, retryable background work.
-- ---------------------------------------------------------------------------
CREATE TABLE shrine.jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid REFERENCES core.projects(id) ON DELETE CASCADE,
  job_type         text NOT NULL,
  entity_type      text,
  entity_id        uuid,
  dedupe_key       text,
  state            text NOT NULL DEFAULT 'queued',
  priority         integer NOT NULL DEFAULT 0,
  payload          jsonb NOT NULL,
  result           jsonb,
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 5,
  run_after        timestamptz NOT NULL DEFAULT now(),
  claimed_by       uuid,
  claim_token      text,
  claimed_at       timestamptz,
  lease_expires_at timestamptz,
  last_error       text,
  correlation_id   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,

  CONSTRAINT jobs_state_allowed
    CHECK (state IN ('queued', 'claimed', 'retrying', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT jobs_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts > 0),
  -- A claimed job must carry the token that authorises its completion.
  CONSTRAINT jobs_claimed_has_token
    CHECK (state <> 'claimed' OR (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

-- The worker's claim query: eligible rows ordered by priority then age.
CREATE INDEX jobs_claimable_idx
  ON shrine.jobs (priority DESC, run_after, created_at)
  WHERE state IN ('queued', 'retrying');
CREATE INDEX jobs_lease_idx ON shrine.jobs (lease_expires_at) WHERE state = 'claimed';
CREATE INDEX jobs_state_idx ON shrine.jobs (state, created_at DESC);
CREATE INDEX jobs_project_idx ON shrine.jobs (project_id, created_at DESC);
CREATE INDEX jobs_entity_idx ON shrine.jobs (entity_type, entity_id);
-- Deduplication applies only while a job is still outstanding; a finished job must not block
-- an identical future one.
CREATE UNIQUE INDEX jobs_dedupe_active_uniq
  ON shrine.jobs (job_type, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'claimed', 'retrying');

-- ---------------------------------------------------------------------------
-- shrine.system_events — human-readable activity and the SSE replay log.
-- ---------------------------------------------------------------------------
CREATE TABLE shrine.system_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence    bigint GENERATED ALWAYS AS IDENTITY,
  severity    text NOT NULL,
  category    text NOT NULL,
  project_id  uuid REFERENCES core.projects(id) ON DELETE CASCADE,
  entity_type text,
  entity_id   uuid,
  event_type  text NOT NULL,
  message     text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT system_events_severity_allowed
    CHECK (severity IN ('info', 'warning', 'error', 'critical'))
);

-- `sequence` is the SSE event id; Last-Event-ID resume is a range scan on this index.
CREATE UNIQUE INDEX system_events_sequence_uniq ON shrine.system_events (sequence);
CREATE INDEX system_events_created_idx ON shrine.system_events (created_at DESC);
CREATE INDEX system_events_project_idx ON shrine.system_events (project_id, sequence DESC);
CREATE INDEX system_events_severity_idx ON shrine.system_events (severity, sequence DESC);
