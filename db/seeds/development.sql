-- Saga development seed.
--
-- Idempotent: safe to run repeatedly. Creates one sample project with representative Lore,
-- Quests in several states, historical sessions and checkpoints, and some Shrine activity.
--
-- Contains no real credentials. The administrator is created by the API on first start from
-- SAGA_BOOTSTRAP_ADMIN_EMAIL / SAGA_BOOTSTRAP_ADMIN_PASSWORD, not here — a seeded password
-- hash would be a credential committed to the repository.

BEGIN;

-- ---------------------------------------------------------------------------
-- project
-- ---------------------------------------------------------------------------
INSERT INTO core.projects (id, name, name_key, description, lore_approval_mode)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'ERP Backoffice',
  'erp backoffice',
  'Order and invoice management for the back office. Seeded development data.',
  'auto'
)
ON CONFLICT (name_key) DO NOTHING;

INSERT INTO core.project_aliases (project_id, alias, alias_key)
VALUES ('11111111-1111-4111-8111-111111111111', 'ERP Back Office', 'erp back office')
ON CONFLICT (alias_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- lore: identity rows, immutable versions, then the current-version pointers
-- ---------------------------------------------------------------------------
INSERT INTO lore.memory_items (id, project_id, memory_key, category, kind, importance, volatility)
VALUES
  ('22222222-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'project.overview',    'overview',     'fact',       95, 'stable'),
  ('22222222-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'structure.top_level', 'structure',    'map',        85, 'stable'),
  ('22222222-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'style.typescript',    'coding_style', 'convention', 70, 'stable'),
  ('22222222-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'run.api.local',       'running',      'procedure',  85, 'operational'),
  ('22222222-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'testing.integration', 'testing',      'procedure',  80, 'operational'),
  ('22222222-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', 'database.primary',    'database',     'entity',     80, 'stable'),
  ('22222222-0000-4000-8000-000000000007', '11111111-1111-4111-8111-111111111111', 'warning.migrations',  'warning',      'warning',   100, 'stable')
ON CONFLICT (project_id, memory_key) DO NOTHING;

INSERT INTO lore.memory_versions
  (id, memory_item_id, body, data, evidence, content_hash, confidence, verification_state,
   embedding_state, search_document)
VALUES
  ('33333333-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000001',
   'An ERP back office for order and invoice management. Used by the finance and fulfilment teams.',
   '{}'::jsonb, '[{"path": "README.md"}]'::jsonb, 'sha256:seed01', 0.95, 'observed', 'queued',
   to_tsvector('english', 'project overview ERP back office order invoice management finance fulfilment')),

  ('33333333-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000002',
   'services/api is the Fastify API, services/worker processes background jobs, apps/web is the operator console.',
   '{"directories": {"services/api": "Fastify API", "services/worker": "background jobs", "apps/web": "operator console"}}'::jsonb,
   '[{"path": "pnpm-workspace.yaml"}]'::jsonb, 'sha256:seed02', 0.9, 'observed', 'queued',
   to_tsvector('english', 'structure top level services api worker apps web fastify console')),

  ('33333333-0000-4000-8000-000000000003', '22222222-0000-4000-8000-000000000003',
   'TypeScript strict mode. No implicit any. Prefer explicit transaction boundaries over helpers that hide them.',
   '{}'::jsonb, '[{"path": "tsconfig.json"}]'::jsonb, 'sha256:seed03', 0.9, 'verified', 'queued',
   to_tsvector('english', 'typescript strict mode implicit any transaction boundaries style convention')),

  ('33333333-0000-4000-8000-000000000004', '22222222-0000-4000-8000-000000000004',
   'Start PostgreSQL and Redis before starting the API.',
   '{"working_directory": "services/api", "commands": ["docker compose up -d postgres redis", "pnpm --filter api dev"], "healthcheck": {"method": "GET", "url": "http://localhost:3000/health", "expected_status": 200}, "required_environment_variables": ["DATABASE_URL", "REDIS_URL"]}'::jsonb,
   '[{"path": "services/api/package.json"}, {"path": "docker-compose.yml"}]'::jsonb,
   'sha256:seed04', 0.95, 'verified', 'queued',
   to_tsvector('english', 'run api local start postgresql redis docker compose pnpm dev healthcheck')),

  ('33333333-0000-4000-8000-000000000005', '22222222-0000-4000-8000-000000000005',
   'Integration tests require the test PostgreSQL database and Redis. They truncate every domain table between tests.',
   '{"commands": ["pnpm test:integration"], "required_environment_variables": ["TEST_DATABASE_URL", "REDIS_URL"]}'::jsonb,
   '[{"path": "package.json"}]'::jsonb, 'sha256:seed05', 0.9, 'observed', 'queued',
   to_tsvector('english', 'testing integration tests postgresql redis truncate database commands')),

  ('33333333-0000-4000-8000-000000000006', '22222222-0000-4000-8000-000000000006',
   'PostgreSQL 16 with pgvector. Migrations are forward-only and run under an advisory lock.',
   '{"engine": "postgresql", "version": "16", "extensions": ["pgvector", "pg_trgm"]}'::jsonb,
   '[{"path": "db/migrations"}]'::jsonb, 'sha256:seed06', 0.9, 'observed', 'queued',
   to_tsvector('english', 'database primary postgresql pgvector migrations forward only advisory lock')),

  ('33333333-0000-4000-8000-000000000007', '22222222-0000-4000-8000-000000000007',
   'Never run the destructive reset migration against a production database. It drops every domain schema.',
   '{}'::jsonb, '[]'::jsonb, 'sha256:seed07', 1.0, 'verified', 'queued',
   to_tsvector('english', 'warning migrations destructive reset production database drops schema'))
ON CONFLICT (id) DO NOTHING;

UPDATE lore.memory_items i
   SET current_version_id = v.id, last_verified_at = now()
  FROM lore.memory_versions v
 WHERE v.memory_item_id = i.id
   AND i.project_id = '11111111-1111-4111-8111-111111111111'
   AND i.current_version_id IS NULL;

-- One stale entry, so Guild Hall's stale handling is visible in development.
UPDATE lore.memory_items
   SET state = 'stale', stale_reason = 'The start command changed in the last release.'
 WHERE id = '22222222-0000-4000-8000-000000000004' AND state = 'active';

INSERT INTO lore.memory_links (project_id, from_memory_item_id, relation, to_memory_item_id)
VALUES
  ('11111111-1111-4111-8111-111111111111', '22222222-0000-4000-8000-000000000004', 'uses',      '22222222-0000-4000-8000-000000000006'),
  ('11111111-1111-4111-8111-111111111111', '22222222-0000-4000-8000-000000000006', 'tested_by', '22222222-0000-4000-8000-000000000005')
ON CONFLICT DO NOTHING;

INSERT INTO core.projects (id, name, name_key, description)
VALUES ('11111111-1111-4111-8111-111111111112', 'Payment Gateway', 'payment gateway', 'Card and bank payment routing.')
ON CONFLICT (name_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- quests in several states, plus a Questline
-- ---------------------------------------------------------------------------
INSERT INTO quest.work_items
  (id, project_id, parent_work_item_id, title, objective, status, priority, scope, search_document)
VALUES
  ('44444444-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', NULL,
   'Improve authentication security', 'Rotate refresh tokens safely and detect reuse.', 'in_progress', 'high',
   '{"modules": ["services/api/src/auth"], "issue_keys": ["AUTH-142"]}'::jsonb,
   to_tsvector('english', 'improve authentication security refresh tokens reuse detection')),

  ('44444444-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '44444444-0000-4000-8000-000000000001',
   'Add token-family schema', 'Add a token family so an entire family can be revoked.', 'completed', 'high',
   '{"modules": ["packages/database"], "databases": ["database.primary"]}'::jsonb,
   to_tsvector('english', 'add token family schema revoke migration database')),

  ('44444444-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', '44444444-0000-4000-8000-000000000001',
   'Implement token rotation', 'Rotate the refresh token on every use.', 'in_progress', 'high',
   '{"modules": ["services/api/src/auth"], "apis": ["/v1/auth/refresh"]}'::jsonb,
   to_tsvector('english', 'implement token rotation refresh every use')),

  ('44444444-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', NULL,
   'Add CSV report export', 'Stream large report exports as CSV.', 'blocked', 'normal',
   '{"modules": ["services/api/src/reports"], "apis": ["/v1/reports/export"]}'::jsonb,
   to_tsvector('english', 'add csv report export stream large')),

  ('44444444-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', NULL,
   'Upgrade the logging library', NULL, 'open', 'low', '{}'::jsonb,
   to_tsvector('english', 'upgrade logging library'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO quest.work_item_dependencies (work_item_id, depends_on_work_item_id, dependency_type)
VALUES ('44444444-0000-4000-8000-000000000003', '44444444-0000-4000-8000-000000000002', 'must_complete_before')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- historical sessions and checkpoints
-- ---------------------------------------------------------------------------
INSERT INTO quest.sessions
  (id, project_id, work_item_id, client, agent, state, activation_mode, initial_task,
   started_memory_revision, started_at, activated_at, ended_at)
VALUES
  ('55555555-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   '44444444-0000-4000-8000-000000000002', 'claude-code', 'claude', 'completed', 'new_work',
   'Add the token-family schema', 0, now() - interval '3 days', now() - interval '3 days', now() - interval '3 days'),

  ('55555555-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
   '44444444-0000-4000-8000-000000000004', 'codex', 'codex', 'completed', 'new_work',
   'Add CSV report export', 0, now() - interval '1 day', now() - interval '1 day', now() - interval '20 hours')
ON CONFLICT (id) DO NOTHING;

INSERT INTO quest.checkpoints
  (id, session_id, work_item_id, base_work_item_revision, sequence, kind, summary, work_state, created_at)
VALUES
  ('66666666-0000-4000-8000-000000000001', '55555555-0000-4000-8000-000000000001',
   '44444444-0000-4000-8000-000000000002', 0, 1, 'milestone',
   'Added the token_family_id column and its migration',
   '{"goal": "Add a token family so an entire family can be revoked", "completed": ["Wrote the migration"], "in_progress": ["Backfill"], "next_steps": ["Apply to staging"], "blockers": [], "decisions": [], "changed_files": [], "commands": [], "tests": []}'::jsonb,
   now() - interval '3 days'),

  ('66666666-0000-4000-8000-000000000002', '55555555-0000-4000-8000-000000000001',
   '44444444-0000-4000-8000-000000000002', 1, 2, 'final_handoff',
   'Token-family schema is applied and backfilled',
   '{"goal": "Add a token family so an entire family can be revoked", "completed": ["Migration written", "Backfill completed"], "in_progress": [], "next_steps": ["Implement rotation on top of it"], "blockers": [], "decisions": [{"decision": "Revoke the entire family on reuse", "reason": "This prevents replay after token theft"}], "changed_files": [{"path": "db/migrations/0007_token_family.sql", "current_hash": "sha256:seed"}], "commands": [{"command": "pnpm db:migrate", "status": "succeeded"}], "tests": [{"name": "auth integration", "status": "passed"}]}'::jsonb,
   now() - interval '3 days'),

  ('66666666-0000-4000-8000-000000000003', '55555555-0000-4000-8000-000000000002',
   '44444444-0000-4000-8000-000000000004', 0, 1, 'final_handoff',
   'Stopped: the report service has no streaming interface',
   '{"goal": "Stream large report exports as CSV", "completed": ["CSV serialization"], "in_progress": ["Wiring the endpoint"], "next_steps": ["Add ReportService.stream()", "Wire POST /v1/reports/export"], "blockers": [{"description": "The report service lacks a streaming interface", "suggested_action": "Add ReportService.stream() first"}], "decisions": [{"decision": "Stream rather than buffer", "reason": "Reports can exceed available memory"}], "changed_files": [{"path": "services/api/src/reports/csv.ts", "current_hash": "sha256:seed"}], "commands": [{"command": "pnpm test:unit", "status": "succeeded"}], "tests": [{"name": "csv serialization", "status": "passed"}]}'::jsonb,
   now() - interval '20 hours')
ON CONFLICT (id) DO NOTHING;

UPDATE quest.work_items SET revision = 2, latest_checkpoint_id = '66666666-0000-4000-8000-000000000002'
 WHERE id = '44444444-0000-4000-8000-000000000002' AND revision = 0;
UPDATE quest.work_items SET revision = 1, latest_checkpoint_id = '66666666-0000-4000-8000-000000000003'
 WHERE id = '44444444-0000-4000-8000-000000000004' AND revision = 0;

-- ---------------------------------------------------------------------------
-- shrine activity
-- ---------------------------------------------------------------------------
INSERT INTO shrine.jobs (id, project_id, job_type, state, payload, attempts, max_attempts, last_error, completed_at)
VALUES
  ('77777777-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'noop', 'succeeded',
   '{"echo": "seed"}'::jsonb, 1, 5, NULL, now() - interval '2 hours'),
  ('77777777-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'embedding', 'failed',
   '{"memory_version_id": "33333333-0000-4000-8000-000000000001"}'::jsonb, 5, 5,
   'Seeded failure so the Shrine retry flow can be exercised.', now() - interval '1 hour')
ON CONFLICT (id) DO NOTHING;

INSERT INTO shrine.system_events (severity, category, project_id, event_type, message, metadata)
VALUES
  ('info',    'core',  '11111111-1111-4111-8111-111111111111', 'core.project_created',   'Project "ERP Backoffice" was created.', '{}'::jsonb),
  ('info',    'lore',  '11111111-1111-4111-8111-111111111111', 'lore.memory_published',  'Lore revision 1 was published (7 entries).', '{}'::jsonb),
  ('warning', 'lore',  '11111111-1111-4111-8111-111111111111', 'lore.memory_marked_stale', 'Lore entry "run.api.local" was marked stale.', '{}'::jsonb),
  ('error',   'job',   '11111111-1111-4111-8111-111111111111', 'shrine.job_failed',      'Job embedding failed permanently after 5 attempt(s).', '{}'::jsonb);

-- The seeded Lore was inserted directly, so the project revision is set to match.
UPDATE core.projects SET memory_revision = 1
 WHERE id = '11111111-1111-4111-8111-111111111111' AND memory_revision = 0;

COMMIT;
