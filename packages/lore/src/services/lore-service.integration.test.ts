import type { LoreEntryInput } from '@saga/contracts';
import type { Project } from '@saga/core';
import { PgOutboxRepository, PgProjectRepository, ProjectService } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { JobService, PgJobRepository, PgSystemEventRepository } from '@saga/shrine';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, testConfig, truncateAll } from '../../../../testing/harness.js';
import { DeterministicFakeEmbeddingProvider } from '../embedding/provider.js';
import { LinkRepository } from '../repositories/link-repository.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { SearchRepository } from '../repositories/search-repository.js';
import { SnapshotRepository } from '../repositories/snapshot-repository.js';
import { LoreService } from './lore-service.js';
import { SearchService } from './search-service.js';
import { createSilentLogger } from '@saga/shared/logging';

let pool: SagaPool;
let lore: LoreService;
let search: SearchService;
let projects: ProjectService;
let project: Project;

const memory = new MemoryRepository();
const snapshots = new SnapshotRepository();
const links = new LinkRepository();
const projectRepo = new PgProjectRepository();
const embeddings = new DeterministicFakeEmbeddingProvider(768);

function entry(overrides: Partial<LoreEntryInput> & { memory_key: string }): LoreEntryInput {
  return {
    category: 'overview',
    kind: 'fact',
    body: `Body for ${overrides.memory_key}.`,
    confidence: 0.9,
    verification_state: 'observed',
    ...overrides,
  };
}

beforeEach(async () => {
  if (pool === undefined) {
    pool = createTestPool('saga-lore-test');
    const config = testConfig();
    const outbox = new PgOutboxRepository();
    const jobs = new JobService({
      pool,
      jobs: new PgJobRepository(),
      events: new PgSystemEventRepository(),
      jobLeaseSeconds: 60,
      jobMaxAttempts: 5,
    });
    projects = new ProjectService({ pool, projects: projectRepo, outbox });
    lore = new LoreService({
      pool,
      memory,
      snapshots,
      projects: projectRepo,
      outbox,
      jobs,
      coreContextTokens: config.context.coreTokens,
    });
    search = new SearchService({
      pool,
      search: new SearchRepository(),
      memory,
      links,
      embeddings,
      logger: createSilentLogger(),
    });
  }
  await truncateAll(pool);
  project = await projects.create({ name: 'Lore Test Project' });
});

afterAll(async () => {
  await pool?.end();
});

/** Propose, validate and publish in one step, the way the worker does in `auto` mode. */
async function publishEntries(entries: LoreEntryInput[], summary = 'test'): Promise<number> {
  const update = await lore.propose({ project, entries, summary });
  await lore.validate(update.id);
  const result = await lore.publish(update.id);
  project = await projects.resolve(project.id);
  return result.memoryRevision;
}

describe('proposal', () => {
  it('creates candidate versions without changing what readers see', async () => {
    const update = await lore.propose({
      project,
      entries: [entry({ memory_key: 'project.overview' })],
      summary: 'first',
    });
    expect(update.state).toBe('draft');

    const item = await memory.findItemByKey(pool, project.id, 'project.overview');
    expect(item).not.toBeNull();
    // Identity exists, but nothing is published yet.
    expect(item!.currentVersionId).toBeNull();

    const refreshed = await projects.resolve(project.id);
    expect(refreshed.memoryRevision).toBe(0);
    expect(refreshed.activeContextSnapshotId).toBeNull();
  });

  it('queues an embedding job per candidate in the same transaction', async () => {
    await lore.propose({
      project,
      entries: [entry({ memory_key: 'a.one' }), entry({ memory_key: 'a.two' })],
      summary: 'two entries',
    });
    const jobs = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM shrine.jobs WHERE job_type = 'embedding' AND project_id = $1`,
      [project.id],
    );
    expect(Number(jobs.rows[0]!.count)).toBe(2);
  });

  it('rejects a proposal containing a secret before anything is stored', async () => {
    await expect(
      lore.propose({
        project,
        entries: [
          entry({
            memory_key: 'config.prod',
            category: 'config',
            body: 'DATABASE_URL=postgres://saga:hunter2xyz@prod:5432/saga',
          }),
        ],
        summary: 'oops',
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_SECRET_DETECTED' });

    const updates = await lore.listUpdates(project.id);
    expect(updates).toHaveLength(0);
  });

  it('rejects the same memory key twice in one proposal', async () => {
    await expect(
      lore.propose({
        project,
        entries: [entry({ memory_key: 'a.one' }), entry({ memory_key: 'a.one', body: 'other' })],
        summary: 'duplicate',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses to write Lore into an archived project', async () => {
    await projects.archive(project.id, 'retired');
    const archived = await projects.resolve(project.id);
    await expect(
      lore.propose({ project: archived, entries: [entry({ memory_key: 'a.one' })], summary: 'x' }),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
  });
});

describe('publication', () => {
  it('moves the pointer, bumps the revision once, and activates a snapshot atomically', async () => {
    const revision = await publishEntries([
      entry({ memory_key: 'project.overview', category: 'overview' }),
      entry({ memory_key: 'run.local', category: 'running', kind: 'procedure' }),
    ]);

    expect(revision).toBe(1);
    const refreshed = await projects.resolve(project.id);
    expect(refreshed.memoryRevision).toBe(1);
    expect(refreshed.activeContextSnapshotId).not.toBeNull();

    const snapshot = await snapshots.findActive(pool, project.id);
    expect(snapshot?.state).toBe('active');
    expect(snapshot?.renderedContext).toContain('project.overview');

    const item = await memory.findItemWithVersion(pool, project.id, 'project.overview');
    expect(item?.currentVersion).not.toBeNull();
    expect(item?.state).toBe('active');
  });

  it('emits the publication event in the same transaction', async () => {
    await publishEntries([entry({ memory_key: 'project.overview' })]);
    const events = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM core.outbox_events WHERE topic = 'lore.memory_published'`,
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload).toMatchObject({ memory_revision: 1, entry_count: 1 });
  });

  it('keeps exactly one active snapshot after several publishes', async () => {
    await publishEntries([entry({ memory_key: 'a.one' })]);
    await publishEntries([entry({ memory_key: 'a.two' })]);
    await publishEntries([entry({ memory_key: 'a.three' })]);

    const active = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM lore.context_snapshots WHERE project_id = $1 AND state = 'active'`,
      [project.id],
    );
    expect(Number(active.rows[0]!.count)).toBe(1);
    expect((await projects.resolve(project.id)).memoryRevision).toBe(3);
  });

  it('is idempotent: publishing twice does not bump the revision twice', async () => {
    const update = await lore.propose({
      project,
      entries: [entry({ memory_key: 'a.one' })],
      summary: 'x',
    });
    await lore.validate(update.id);
    await lore.publish(update.id);
    await lore.publish(update.id);
    expect((await projects.resolve(project.id)).memoryRevision).toBe(1);
  });

  it('refuses to publish an update that has not been validated', async () => {
    const update = await lore.propose({
      project,
      entries: [entry({ memory_key: 'a.one' })],
      summary: 'x',
    });
    await expect(lore.publish(update.id)).rejects.toMatchObject({
      code: 'MEMORY_UPDATE_STATE_INVALID',
    });
  });
});

describe('concurrent publication', () => {
  it('publishes updates that touch different entries concurrently', async () => {
    // Acceptance criterion 6.
    const first = await lore.propose({
      project,
      entries: [entry({ memory_key: 'a.one' })],
      summary: 'first',
    });
    const second = await lore.propose({
      project,
      entries: [entry({ memory_key: 'b.two' })],
      summary: 'second',
    });
    await lore.validate(first.id);
    await lore.validate(second.id);

    const results = await Promise.allSettled([lore.publish(first.id), lore.publish(second.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);

    const refreshed = await projects.resolve(project.id);
    expect(refreshed.memoryRevision).toBe(2);

    for (const key of ['a.one', 'b.two']) {
      const item = await memory.findItemWithVersion(pool, project.id, key);
      expect(item?.currentVersion, key).not.toBeNull();
    }
  });

  it('produces one winner and one conflict for the same entry', async () => {
    // Acceptance criterion 7.
    await publishEntries([entry({ memory_key: 'a.one', body: 'original' })]);

    const first = await lore.propose({
      project,
      entries: [entry({ memory_key: 'a.one', body: 'change from A' })],
      summary: 'A',
    });
    const second = await lore.propose({
      project,
      entries: [entry({ memory_key: 'a.one', body: 'change from B' })],
      summary: 'B',
    });
    await lore.validate(first.id);
    await lore.validate(second.id);

    const results = await Promise.allSettled([lore.publish(first.id), lore.publish(second.id)]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'MEMORY_UPDATE_CONFLICT',
    });

    // Exactly one revision bump, and the loser is recorded as `conflict`.
    expect((await projects.resolve(project.id)).memoryRevision).toBe(2);
    const states = await lore.listUpdates(project.id);
    expect(states.filter((update) => update.state === 'published')).toHaveLength(2);
    expect(states.filter((update) => update.state === 'conflict')).toHaveLength(1);
  });

  it('changes no pointer when a publish conflicts on any one of several entries', async () => {
    await publishEntries([
      entry({ memory_key: 'a.one', body: 'original one' }),
      entry({ memory_key: 'b.two', body: 'original two' }),
    ]);

    const stale = await lore.propose({
      project,
      entries: [
        entry({ memory_key: 'a.one', body: 'stale change' }),
        entry({ memory_key: 'b.two', body: 'stale change too' }),
      ],
      summary: 'stale',
    });
    await lore.validate(stale.id);

    // Someone else changes only `a.one` in between.
    await publishEntries([entry({ memory_key: 'a.one', body: 'winner' })]);

    await expect(lore.publish(stale.id)).rejects.toMatchObject({
      code: 'MEMORY_UPDATE_CONFLICT',
    });

    // `b.two` must be untouched: a partial publish would leave Lore incoherent.
    const two = await memory.findItemWithVersion(pool, project.id, 'b.two');
    expect(two?.currentVersion?.body).toBe('original two');
    const one = await memory.findItemWithVersion(pool, project.id, 'a.one');
    expect(one?.currentVersion?.body).toBe('winner');
  });

  it('leaves the active snapshot untouched after a failed publish', async () => {
    await publishEntries([entry({ memory_key: 'a.one', body: 'original' })]);
    const before = await snapshots.findActive(pool, project.id);

    const stale = await lore.propose({
      project,
      entries: [entry({ memory_key: 'a.one', body: 'stale' })],
      summary: 'stale',
    });
    await lore.validate(stale.id);
    await publishEntries([entry({ memory_key: 'a.one', body: 'winner' })]);
    const afterWinner = await snapshots.findActive(pool, project.id);

    await expect(lore.publish(stale.id)).rejects.toThrow();

    const after = await snapshots.findActive(pool, project.id);
    expect(after?.id).toBe(afterWinner?.id);
    expect(after?.id).not.toBe(before?.id);
  });
});

describe('stale and archive', () => {
  it('marks an entry stale without deleting it, and records the reason', async () => {
    await publishEntries([entry({ memory_key: 'run.local', category: 'running' })]);
    const item = await lore.markStale(project, 'run.local', 'the start command changed');

    expect(item.state).toBe('stale');
    expect(item.staleReason).toBe('the start command changed');

    const stored = await memory.findItemWithVersion(pool, project.id, 'run.local');
    expect(stored?.currentVersion?.body).toContain('Body for run.local');
  });

  it('excludes a stale entry from a rebuilt core snapshot but keeps it searchable', async () => {
    await publishEntries([
      entry({ memory_key: 'run.local', category: 'running' }),
      entry({ memory_key: 'project.overview', category: 'overview' }),
    ]);
    await lore.markStale(project, 'run.local', 'drifted');

    const results = await search.search(await projects.resolve(project.id), {
      query: 'run local',
      filters: { states: ['active', 'stale'] },
    });
    const hit = results.hits.find((entry) => entry.memory_key === 'run.local');
    expect(hit?.state).toBe('stale');
    expect(results.warnings.some((warning) => warning.includes('stale'))).toBe(true);
  });

  it('archives an entry so it disappears from search entirely', async () => {
    await publishEntries([entry({ memory_key: 'old.thing', body: 'obsolete knowledge' })]);
    await lore.archiveEntry(project, 'old.thing', 'no longer true');

    const results = await search.search(await projects.resolve(project.id), {
      query: 'obsolete knowledge',
    });
    expect(results.hits.map((hit) => hit.memory_key)).not.toContain('old.thing');
  });
});

describe('search against real PostgreSQL', () => {
  beforeEach(async () => {
    await publishEntries([
      entry({
        memory_key: 'run.api.local',
        category: 'running',
        kind: 'procedure',
        body: 'Start PostgreSQL and Redis before starting the API.',
        data: { commands: ['docker compose up -d postgres redis'] },
      }),
      entry({
        memory_key: 'testing.integration',
        category: 'testing',
        kind: 'procedure',
        body: 'Integration tests require the test PostgreSQL database.',
      }),
      entry({
        memory_key: 'project.overview',
        category: 'overview',
        body: 'An ERP back office for orders and invoices.',
      }),
    ]);
    // Embeddings are produced by the worker; simulate it so the vector channel participates.
    const items = await memory.listItems(pool, { projectId: project.id, limit: 100 });
    for (const item of items) {
      if (item.currentVersion === null) continue;
      const [vector] = await embeddings.embed([item.currentVersion.body]);
      await memory.setEmbedding(pool, item.currentVersion.id, vector!, 'fake');
    }
  });

  it('finds an entry by its words', async () => {
    const results = await search.search(await projects.resolve(project.id), {
      query: 'start the API locally',
      limit: 5,
    });
    expect(results.hits[0]?.memory_key).toBe('run.api.local');
    expect(results.mode).toBe('full');
  });

  it('finds an entry by a fragment of its key, where stemming would not help', async () => {
    const results = await search.search(await projects.resolve(project.id), {
      query: 'testing.integr',
      limit: 5,
    });
    expect(results.hits.map((hit) => hit.memory_key)).toContain('testing.integration');
  });

  it('respects category filters', async () => {
    const results = await search.search(await projects.resolve(project.id), {
      query: 'PostgreSQL',
      filters: { categories: ['testing'] },
    });
    expect(results.hits.every((hit) => hit.category === 'testing')).toBe(true);
  });

  it('degrades to text search when the embedding provider fails', async () => {
    const failing = new SearchService({
      pool,
      search: new SearchRepository(),
      memory,
      links,
      embeddings: {
        name: 'broken',
        dimensions: 768,
        healthCheck: async () => ({ status: 'unhealthy' as const, message: 'down' }),
        embed: async () => {
          throw new Error('provider is down');
        },
      },
      logger: createSilentLogger(),
    });

    const results = await failing.search(await projects.resolve(project.id), {
      query: 'start the API locally',
    });
    expect(results.mode).toBe('degraded');
    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.warnings.join(' ')).toContain('embedding provider is unavailable');
  });

  it('expands one hop to an entry the query itself does not match', async () => {
    // The linked entry deliberately shares no vocabulary with the query, so it can only
    // appear through relation expansion.
    await publishEntries([
      entry({
        memory_key: 'database.primary',
        category: 'database',
        kind: 'entity',
        body: 'Ledger storage for settled financial records.',
      }),
    ]);
    const from = await memory.findItemByKey(pool, project.id, 'run.api.local');
    const to = await memory.findItemByKey(pool, project.id, 'database.primary');
    await links.create(pool, {
      projectId: project.id,
      fromMemoryItemId: from!.id,
      relation: 'uses',
      toMemoryItemId: to!.id,
      metadata: {},
    });

    const withoutExpansion = await search.search(await projects.resolve(project.id), {
      query: 'start the API locally',
      limit: 3,
      relation_depth: 0,
    });
    expect(withoutExpansion.hits.map((hit) => hit.memory_key)).not.toContain('database.primary');

    const results = await search.search(await projects.resolve(project.id), {
      query: 'start the API locally',
      limit: 6,
      relation_depth: 1,
    });
    const related = results.hits.find((hit) => hit.memory_key === 'database.primary');
    expect(related?.via_relation).toEqual({ from_memory_key: 'run.api.local', relation: 'uses' });
    expect(related?.matched_by).toEqual(['relation']);
  });

  it('does not expand at depth zero', async () => {
    const results = await search.search(await projects.resolve(project.id), {
      query: 'start the API locally',
      relation_depth: 0,
    });
    expect(results.hits.every((hit) => hit.via_relation === null)).toBe(true);
  });
});
