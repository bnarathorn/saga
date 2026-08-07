import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiHarness, type ApiClient, type ApiHarness } from '../testing/api-harness.js';

let harness: ApiHarness;
let admin: ApiClient;
let projectRef: string;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
  admin = await harness.loginAs('admin');
  const created = await admin.post('/api/projects', { name: 'Lore API Project' });
  projectRef = created.body.project.id;
});

const overview = {
  memory_key: 'project.overview',
  category: 'overview',
  kind: 'fact',
  body: 'An ERP back office for orders and invoices.',
  confidence: 0.95,
  verification_state: 'observed',
  importance: 95,
};

const runLocal = {
  memory_key: 'run.api.local',
  category: 'running',
  kind: 'procedure',
  body: 'Start PostgreSQL and Redis before starting the API.',
  data: { commands: ['docker compose up -d postgres redis'] },
  confidence: 0.9,
  verification_state: 'observed',
};

/** Drive the pipeline synchronously, the way the worker does in `auto` mode. */
async function proposeAndPublish(entries: unknown[], summary = 'test'): Promise<any> {
  const proposed = await admin.post(`/api/projects/${projectRef}/lore/remember`, {
    entries,
    summary,
  });
  expect(proposed.status).toBe(202);
  const updateId = proposed.body.update.id;
  await admin.post(`/api/lore/updates/${updateId}/validate`);
  return admin.post(`/api/lore/updates/${updateId}/publish`);
}

describe('remember', () => {
  it('creates a candidate update without changing current Lore', async () => {
    const proposed = await admin.post(`/api/projects/${projectRef}/lore/remember`, {
      entries: [overview],
      summary: 'record the overview',
    });
    expect(proposed.status).toBe(202);
    expect(proposed.body.update.state).toBe('draft');
    expect(proposed.body.approval_mode).toBe('auto');
    expect(proposed.body.update.items).toHaveLength(1);
    expect(proposed.body.update.items[0].base_version_id).toBeNull();

    const listed = await admin.get(`/api/projects/${projectRef}/lore`);
    expect(listed.body.memory_revision).toBe(0);
    expect(listed.body.items[0].current_version).toBeNull();
  });

  it('rejects a candidate containing a credential and names the field', async () => {
    const response = await admin.post(`/api/projects/${projectRef}/lore/remember`, {
      entries: [
        {
          ...overview,
          memory_key: 'config.prod',
          category: 'config',
          body: 'DATABASE_URL=postgres://saga:hunter2xyz@prod:5432/saga',
        },
      ],
      summary: 'oops',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('MEMORY_SECRET_DETECTED');
    expect(response.body.error.details.findings[0].field_path).toBe('body');
    // The secret value itself must never be echoed back.
    expect(JSON.stringify(response.body)).not.toContain('hunter2xyz');
  });

  it('rejects an invalid memory key', async () => {
    const response = await admin.post(`/api/projects/${projectRef}/lore/remember`, {
      entries: [{ ...overview, memory_key: 'Project Overview' }],
      summary: 'bad key',
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error.details)).toContain('memory_key');
  });

  it('supports Idempotency-Key so a retried proposal creates one update', async () => {
    const headers = { 'idempotency-key': 'remember-once-please' };
    const first = await admin.post(
      `/api/projects/${projectRef}/lore/remember`,
      { entries: [overview], summary: 'once' },
      headers,
    );
    const second = await admin.post(
      `/api/projects/${projectRef}/lore/remember`,
      { entries: [overview], summary: 'once' },
      headers,
    );
    expect(second.body.update.id).toBe(first.body.update.id);
  });
});

describe('publication', () => {
  it('publishes atomically and advertises the new revision', async () => {
    const published = await proposeAndPublish([overview, runLocal], 'initial knowledge');
    expect(published.status).toBe(200);
    expect(published.body.memory_revision).toBe(1);
    expect(published.body.update.state).toBe('published');

    const listed = await admin.get(`/api/projects/${projectRef}/lore`);
    expect(listed.body.memory_revision).toBe(1);
    expect(listed.body.items.map((item: { memory_key: string }) => item.memory_key).sort()).toEqual(
      ['project.overview', 'run.api.local'],
    );
    for (const item of listed.body.items) {
      expect(item.current_version).not.toBeNull();
      expect(item.state).toBe('active');
    }
  });

  it('activates a context snapshot in the same operation', async () => {
    await proposeAndPublish([overview, runLocal]);
    const snapshot = await admin.get(`/api/projects/${projectRef}/context/snapshot`);
    expect(snapshot.body.snapshot.state).toBe('active');
    expect(snapshot.body.snapshot.rendered_context).toContain('project.overview');
    expect(snapshot.body.bootstrap_plan).toBeNull();

    const project = await admin.get(`/api/projects/${projectRef}`);
    expect(project.body.project.bootstrap_required).toBe(false);
    expect(project.body.project.active_context_snapshot_id).toBe(snapshot.body.snapshot.id);
  });

  it('returns 409 with the conflicting keys when the entry moved underneath', async () => {
    await proposeAndPublish([overview], 'first');

    // Two proposals from the same base; the second must lose.
    const a = await admin.post(`/api/projects/${projectRef}/lore/remember`, {
      entries: [{ ...overview, body: 'Change from A.' }],
      summary: 'A',
    });
    const b = await admin.post(`/api/projects/${projectRef}/lore/remember`, {
      entries: [{ ...overview, body: 'Change from B.' }],
      summary: 'B',
    });

    await admin.post(`/api/lore/updates/${a.body.update.id}/validate`);
    await admin.post(`/api/lore/updates/${b.body.update.id}/validate`);
    expect((await admin.post(`/api/lore/updates/${a.body.update.id}/publish`)).status).toBe(200);

    const loser = await admin.post(`/api/lore/updates/${b.body.update.id}/publish`);
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe('MEMORY_UPDATE_CONFLICT');
    expect(loser.body.error.details.conflicts[0].memory_key).toBe('project.overview');

    // The losing update is durably recorded as `conflict`, not left in `ready`.
    const after = await admin.get(`/api/lore/updates/${b.body.update.id}`);
    expect(after.body.update.state).toBe('conflict');

    const entry = await admin.get(`/api/projects/${projectRef}/lore/project.overview`);
    expect(entry.body.entry.current_version.body).toBe('Change from A.');
  });

  it('refuses to publish before validation', async () => {
    const proposed = await admin.post(`/api/projects/${projectRef}/lore/remember`, {
      entries: [overview],
      summary: 'x',
    });
    const response = await admin.post(`/api/lore/updates/${proposed.body.update.id}/publish`);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('MEMORY_UPDATE_STATE_INVALID');
  });

  it('can cancel a proposal before it publishes', async () => {
    const proposed = await admin.post(`/api/projects/${projectRef}/lore/remember`, {
      entries: [overview],
      summary: 'x',
    });
    const cancelled = await admin.post(`/api/lore/updates/${proposed.body.update.id}/cancel`, {
      reason: 'proposed by mistake',
    });
    expect(cancelled.body.update.state).toBe('cancelled');

    const republish = await admin.post(`/api/lore/updates/${proposed.body.update.id}/publish`);
    expect(republish.status).toBe(422);
  });
});

describe('version history', () => {
  it('keeps every version and points at the current one', async () => {
    await proposeAndPublish([overview], 'first');
    await proposeAndPublish([{ ...overview, body: 'A revised overview.' }], 'second');

    const versions = await admin.get(`/api/projects/${projectRef}/lore/project.overview/versions`);
    expect(versions.body.items).toHaveLength(2);
    expect(versions.body.items[0].id).toBe(versions.body.current_version_id);
    expect(versions.body.items[0].body).toBe('A revised overview.');
    expect(versions.body.items[1].body).toBe(overview.body);
  });
});

describe('search', () => {
  beforeEach(async () => {
    await proposeAndPublish([
      overview,
      runLocal,
      {
        memory_key: 'testing.integration',
        category: 'testing',
        kind: 'procedure',
        body: 'Integration tests require the test PostgreSQL database.',
        confidence: 0.9,
        verification_state: 'observed',
      },
    ]);
  });

  it('finds an entry by its words', async () => {
    const response = await admin.post(`/api/projects/${projectRef}/lore/search`, {
      query: 'how do I start the API locally',
      limit: 5,
    });
    expect(response.status).toBe(200);
    expect(response.body.hits[0].memory_key).toBe('run.api.local');
    expect(response.body.hits[0].matched_by.length).toBeGreaterThan(0);
    expect(response.body.memory_revision).toBe(1);
  });

  it('applies category filters', async () => {
    const response = await admin.post(`/api/projects/${projectRef}/lore/search`, {
      query: 'PostgreSQL',
      filters: { categories: ['testing'] },
    });
    expect(
      response.body.hits.every((hit: { category: string }) => hit.category === 'testing'),
    ).toBe(true);
  });

  it('returns an empty result set rather than an error for a nonsense query', async () => {
    const response = await admin.post(`/api/projects/${projectRef}/lore/search`, {
      query: 'zzzzqqqxxyy',
    });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.hits)).toBe(true);
  });
});

describe('stale and archive', () => {
  beforeEach(async () => {
    await proposeAndPublish([overview, runLocal]);
  });

  it('marks an entry stale with a reason and warns in context', async () => {
    const response = await admin.post(`/api/projects/${projectRef}/lore/run.api.local/mark-stale`, {
      reason: 'the start command changed',
    });
    expect(response.status).toBe(200);
    expect(response.body.entry.state).toBe('stale');
    expect(response.body.entry.stale_reason).toBe('the start command changed');

    const context = await admin.post(`/api/projects/${projectRef}/context`, {});
    expect(context.body.warnings.join(' ')).toContain('stale');

    const audit = await admin.get('/api/shrine/audit?limit=20');
    expect(
      audit.body.items.some((entry: { action: string }) => entry.action === 'lore.marked_stale'),
    ).toBe(true);
  });

  it('requires a reason to mark an entry stale', async () => {
    const response = await admin.post(
      `/api/projects/${projectRef}/lore/run.api.local/mark-stale`,
      {},
    );
    expect(response.status).toBe(422);
  });

  it('archives an entry so it leaves the listing', async () => {
    await admin.post(`/api/projects/${projectRef}/lore/run.api.local/archive`, {
      reason: 'superseded',
    });
    const listed = await admin.get(`/api/projects/${projectRef}/lore`);
    expect(listed.body.items.map((item: { memory_key: string }) => item.memory_key)).not.toContain(
      'run.api.local',
    );
  });
});

describe('evidence checking', () => {
  it('marks an entry stale when its evidence hash drifts', async () => {
    const withEvidence = {
      ...runLocal,
      evidence: [{ path: 'package.json', content_hash: `sha256:${'a'.repeat(64)}` }],
    };
    await proposeAndPublish([withEvidence]);

    const response = await admin.post(`/api/projects/${projectRef}/lore/evidence/check`, {
      observations: [{ path: 'package.json', content_hash: `sha256:${'b'.repeat(64)}` }],
    });

    expect(response.status).toBe(200);
    expect(response.body.drifted).toHaveLength(1);
    expect(response.body.drifted[0]).toMatchObject({
      memory_key: 'run.api.local',
      reason: 'hash_changed',
    });
    expect(response.body.marked_stale).toEqual(['run.api.local']);
  });

  it('marks an entry stale when its evidence disappears', async () => {
    await proposeAndPublish([
      {
        ...runLocal,
        evidence: [{ path: 'docker-compose.yml', content_hash: `sha256:${'c'.repeat(64)}` }],
      },
    ]);
    const response = await admin.post(`/api/projects/${projectRef}/lore/evidence/check`, {
      observations: [{ path: 'docker-compose.yml', content_hash: null }],
    });
    expect(response.body.drifted[0].reason).toBe('path_missing');
  });

  it('reports no drift when the hashes still match', async () => {
    const hash = `sha256:${'d'.repeat(64)}`;
    await proposeAndPublish([
      { ...runLocal, evidence: [{ path: 'package.json', content_hash: hash }] },
    ]);
    const response = await admin.post(`/api/projects/${projectRef}/lore/evidence/check`, {
      observations: [{ path: 'package.json', content_hash: hash }],
    });
    expect(response.body.drifted).toEqual([]);
    expect(response.body.marked_stale).toEqual([]);
  });
});

describe('relations', () => {
  beforeEach(async () => {
    await proposeAndPublish([
      runLocal,
      {
        memory_key: 'database.primary',
        category: 'database',
        kind: 'entity',
        body: 'PostgreSQL 16 with pgvector.',
        confidence: 0.9,
        verification_state: 'observed',
      },
    ]);
  });

  it('links two entries and lists the relation', async () => {
    const created = await admin.post(`/api/projects/${projectRef}/lore-links`, {
      from_memory_key: 'run.api.local',
      relation: 'uses',
      to_memory_key: 'database.primary',
    });
    expect(created.status).toBe(201);
    expect(created.body.link).toMatchObject({
      from_memory_key: 'run.api.local',
      relation: 'uses',
      to_memory_key: 'database.primary',
    });

    const listed = await admin.get(`/api/projects/${projectRef}/lore-links`);
    expect(listed.body.items).toHaveLength(1);
  });

  it('rejects a self-link', async () => {
    const response = await admin.post(`/api/projects/${projectRef}/lore-links`, {
      from_memory_key: 'run.api.local',
      relation: 'uses',
      to_memory_key: 'run.api.local',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('MEMORY_LINK_INVALID');
  });

  it('rejects a duplicate relation', async () => {
    const body = {
      from_memory_key: 'run.api.local',
      relation: 'uses',
      to_memory_key: 'database.primary',
    };
    await admin.post(`/api/projects/${projectRef}/lore-links`, body);
    const duplicate = await admin.post(`/api/projects/${projectRef}/lore-links`, body);
    expect(duplicate.status).toBe(409);
  });

  it('rejects a link to an entry that does not exist', async () => {
    const response = await admin.post(`/api/projects/${projectRef}/lore-links`, {
      from_memory_key: 'run.api.local',
      relation: 'uses',
      to_memory_key: 'nope.missing',
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('MEMORY_ITEM_NOT_FOUND');
  });

  it('reports a hand-made relation as a confirmed human one', async () => {
    const created = await admin.post(`/api/projects/${projectRef}/lore-links`, {
      from_memory_key: 'run.api.local',
      relation: 'uses',
      to_memory_key: 'database.primary',
    });
    expect(created.body.link).toMatchObject({
      state: 'confirmed',
      source: 'human',
      confidence: null,
      rationale: null,
    });
  });
});

describe('inferred relations', () => {
  beforeEach(async () => {
    await proposeAndPublish([
      runLocal,
      {
        memory_key: 'database.primary',
        category: 'database',
        kind: 'entity',
        body: 'PostgreSQL 16 with pgvector.',
        confidence: 0.9,
        verification_state: 'observed',
      },
    ]);
  });

  /** Write a proposal the way the inference job does; nothing on the API can create one. */
  async function proposeRelation(confidence = 0.9): Promise<string> {
    const ids = await harness.pool.query<{ id: string; memory_key: string }>(
      `SELECT id, memory_key FROM lore.memory_items WHERE project_id = $1`,
      [projectRef],
    );
    const from = ids.rows.find((row) => row.memory_key === 'run.api.local')!.id;
    const to = ids.rows.find((row) => row.memory_key === 'database.primary')!.id;
    const inserted = await harness.pool.query<{ id: string }>(
      `INSERT INTO lore.memory_links
         (project_id, from_memory_item_id, relation, to_memory_item_id,
          state, source, confidence, rationale)
       VALUES ($1, $2, 'depends_on', $3, 'proposed', 'model', $4, 'The API stores state in it.')
       RETURNING id`,
      [projectRef, from, to, confidence],
    );
    return inserted.rows[0]!.id;
  }

  it('hides proposals from the default listing', async () => {
    await proposeRelation();
    const listed = await admin.get(`/api/projects/${projectRef}/lore-links`);
    expect(listed.body.items).toEqual([]);
  });

  it('returns proposals only when asked for them', async () => {
    await proposeRelation();
    const listed = await admin.get(`/api/projects/${projectRef}/lore-links?state=proposed`);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      state: 'proposed',
      source: 'model',
      confidence: 0.9,
      rationale: 'The API stores state in it.',
    });
  });

  it('confirming moves a proposal into the graph', async () => {
    const linkId = await proposeRelation();
    const confirmed = await admin.post(`/api/lore-links/${linkId}/confirm`, {});
    expect(confirmed.status).toBe(200);
    // The source stays `model`: who suggested it is still true after somebody agreed.
    expect(confirmed.body.link).toMatchObject({ state: 'confirmed', source: 'model' });

    const listed = await admin.get(`/api/projects/${projectRef}/lore-links`);
    expect(listed.body.items).toHaveLength(1);
    expect(await admin.get(`/api/projects/${projectRef}/lore-links?state=proposed`)).toMatchObject({
      body: { items: [] },
    });
  });

  it('refuses to confirm a relation that is already in the graph', async () => {
    const linkId = await proposeRelation();
    await admin.post(`/api/lore-links/${linkId}/confirm`, {});
    const again = await admin.post(`/api/lore-links/${linkId}/confirm`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('MEMORY_LINK_NOT_PROPOSED');
  });

  it('answers 404 for confirming a relation that does not exist', async () => {
    const response = await admin.post(
      '/api/lore-links/00000000-0000-0000-0000-000000000000/confirm',
      {},
    );
    expect(response.status).toBe(404);
  });

  it('rejects a proposal and keeps the rejection', async () => {
    const linkId = await proposeRelation();
    const removed = await admin.del(`/api/lore-links/${linkId}`);
    expect(removed.status).toBe(200);
    expect(
      (await admin.get(`/api/projects/${projectRef}/lore-links?state=proposed`)).body.items,
    ).toEqual([]);

    // The row survives as a tombstone. Deleting it outright would only hold until the next
    // publish re-proposed the same relation.
    const rejected = await admin.get(`/api/projects/${projectRef}/lore-links?state=rejected`);
    expect(rejected.body.items).toHaveLength(1);
    expect(rejected.body.items[0].id).toBe(linkId);
  });

  it('removes a confirmed relation outright rather than tombstoning it', async () => {
    const linkId = await proposeRelation();
    await admin.post(`/api/lore-links/${linkId}/confirm`, {});
    await admin.del(`/api/lore-links/${linkId}`);

    for (const state of ['confirmed', 'proposed', 'rejected']) {
      const listed = await admin.get(`/api/projects/${projectRef}/lore-links?state=${state}`);
      expect([state, listed.body.items]).toEqual([state, []]);
    }
  });

  it('lets a person create by hand a relation they rejected', async () => {
    const linkId = await proposeRelation();
    await admin.del(`/api/lore-links/${linkId}`);

    const created = await admin.post(`/api/projects/${projectRef}/lore-links`, {
      from_memory_key: 'run.api.local',
      relation: 'depends_on',
      to_memory_key: 'database.primary',
    });
    expect(created.status).toBe(201);
    expect(created.body.link).toMatchObject({
      state: 'confirmed',
      source: 'human',
      confidence: null,
      rationale: null,
    });
  });

  it('refuses an unknown state rather than silently listing the graph', async () => {
    const response = await admin.get(`/api/projects/${projectRef}/lore-links?state=maybe`);
    expect(response.status).toBe(400);
  });
});

describe('context composition', () => {
  it('reports bootstrap guidance before any Lore exists', async () => {
    const response = await admin.post(`/api/projects/${projectRef}/context`, {});
    expect(response.body.bootstrap_required).toBe(true);
    expect(response.body.core_context).toBe('');
    expect(response.body.bootstrap_plan.required).toBe(true);
    expect(response.body.bootstrap_plan.inspect_paths).toContain('README*');
    // The plan must tell the agent not to invent facts.
    expect(response.body.bootstrap_plan.rules.join(' ')).toContain('Never invent');
    // And must exclude secret-bearing files from inspection.
    expect(response.body.bootstrap_plan.exclude_paths).toContain('.env');
  });

  it('returns core context and a task layer once Lore is published', async () => {
    await proposeAndPublish([overview, runLocal]);
    const response = await admin.post(`/api/projects/${projectRef}/context`, {
      task: 'Fix the local API startup',
      mode: 'new_work',
    });

    expect(response.body.bootstrap_required).toBe(false);
    expect(response.body.core_context).toContain('Project Overview');
    expect(response.body.task_context).toContain('run.api.local');
    expect(response.body.continuation).toBeNull();
    expect(response.body.project.memory_revision).toBe(1);
    expect(response.body.token_counts.core).toBeGreaterThan(0);
  });

  it('omits the task layer when no task is supplied', async () => {
    await proposeAndPublish([overview]);
    const response = await admin.post(`/api/projects/${projectRef}/context`, {});
    expect(response.body.task_context).toBeNull();
  });

  it('honours a caller-supplied token budget', async () => {
    await proposeAndPublish([overview, runLocal]);
    const response = await admin.post(`/api/projects/${projectRef}/context`, {
      task: 'startup',
      token_budget: 1_000,
    });
    expect(response.body.token_counts.core + response.body.token_counts.task).toBeLessThan(1_200);
  });
});

describe('authorization', () => {
  it('lets a lore:read token search but not propose', async () => {
    await proposeAndPublish([overview]);
    const issued = await admin.post(`/api/projects/${projectRef}/tokens`, {
      name: 'reader',
      scopes: ['project:read', 'lore:read'],
    });
    const agent = harness.withAgentToken(issued.body.raw_token);

    expect(
      (await agent.post(`/api/projects/${projectRef}/lore/search`, { query: 'ERP' })).status,
    ).toBe(200);
    const denied = await agent.post(`/api/projects/${projectRef}/lore/remember`, {
      entries: [overview],
      summary: 'nope',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('SCOPE_REQUIRED');
  });

  it('hides another project’s Lore update from an agent token', async () => {
    const other = await admin.post('/api/projects', { name: 'Other Lore Project' });
    const proposed = await admin.post(`/api/projects/${other.body.project.id}/lore/remember`, {
      entries: [overview],
      summary: 'theirs',
    });

    const issued = await admin.post(`/api/projects/${projectRef}/tokens`, {
      name: 'mine',
      scopes: ['project:read', 'lore:read'],
    });
    const agent = harness.withAgentToken(issued.body.raw_token);
    const response = await agent.get(`/api/lore/updates/${proposed.body.update.id}`);
    expect(response.status).toBe(404);
  });

  it('refuses Lore writes to an archived project', async () => {
    await admin.post(`/api/projects/${projectRef}/archive`, { reason: 'done' });
    const response = await admin.post(`/api/projects/${projectRef}/lore/remember`, {
      entries: [overview],
      summary: 'x',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PROJECT_ARCHIVED');
  });
});
