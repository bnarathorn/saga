import type { LoreEntryInput } from '@saga/contracts';
import type { Project } from '@saga/core';
import { PgOutboxRepository, PgProjectRepository, ProjectService } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { JobService, PgJobRepository, PgSystemEventRepository } from '@saga/shrine';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, testConfig, truncateAll } from '../../../../testing/harness.js';
import { DeterministicFakeEmbeddingProvider } from '../embedding/provider.js';
import type { ProposedRelation, RelationProposer, RelationSubject } from '../relations/provider.js';
import { NullRelationProposer } from '../relations/provider.js';
import { LinkRepository } from '../repositories/link-repository.js';
import { MemoryRepository } from '../repositories/memory-repository.js';
import { SearchRepository } from '../repositories/search-repository.js';
import { SnapshotRepository } from '../repositories/snapshot-repository.js';
import { LoreService } from './lore-service.js';
import { RelationService } from './relation-service.js';

let pool: SagaPool;
let lore: LoreService;
let projects: ProjectService;
let project: Project;

const memory = new MemoryRepository();
const snapshots = new SnapshotRepository();
const links = new LinkRepository();
const search = new SearchRepository();
const projectRepo = new PgProjectRepository();
const embeddings = new DeterministicFakeEmbeddingProvider(768);

/** Answers with whatever it was handed, so a test can state the model's output exactly. */
class ScriptedProposer implements RelationProposer {
  readonly name = 'scripted';
  seen: RelationSubject[] = [];

  constructor(private readonly answers: Record<string, ProposedRelation[]> = {}) {}

  async propose(subject: RelationSubject): Promise<ProposedRelation[]> {
    this.seen.push(subject);
    return this.answers[subject.memoryKey] ?? [];
  }
}

class FailingProposer implements RelationProposer {
  readonly name = 'failing';
  async propose(): Promise<ProposedRelation[]> {
    throw new Error('the model server is down');
  }
}

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

function relationService(proposer: RelationProposer, minConfidence = 0.6): RelationService {
  return new RelationService({
    pool,
    memory,
    links,
    search,
    proposer,
    maxCandidates: 5,
    minConfidence,
  });
}

beforeEach(async () => {
  if (pool === undefined) {
    pool = createTestPool('saga-relation-test');
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
  }
  await truncateAll(pool);
  project = await projects.create({ name: 'Relation Test Project' });
});

afterAll(async () => {
  await pool?.end();
});

async function publish(entries: LoreEntryInput[]): Promise<string> {
  const update = await lore.propose({ project, entries, summary: 'test' });
  await lore.validate(update.id);
  await lore.publish(update.id);
  project = await projects.resolve(project.id);
  return update.id;
}

/** Give every published version a ready embedding, the way the embedding job would. */
async function embedAll(): Promise<void> {
  const items = await memory.listItems(pool, { projectId: project.id, limit: 100 });
  for (const item of items) {
    if (item.currentVersion === null) continue;
    const [vector] = await embeddings.embed([item.currentVersion.body]);
    await memory.setEmbedding(pool, item.currentVersion.id, vector!, 'fake');
  }
}

async function itemIds(): Promise<string[]> {
  const items = await memory.listItems(pool, { projectId: project.id, limit: 100 });
  return items.map((item) => item.id);
}

describe('deterministic relations', () => {
  it('writes a wiki-link straight into the graph, confirmed', async () => {
    await publish([
      entry({ memory_key: 'database.migrations', body: 'Forward-only. See [[decision.schema]].' }),
      entry({ memory_key: 'decision.schema', body: 'Schema decisions live here.' }),
    ]);

    const outcome = await relationService(new NullRelationProposer()).inferForItems(
      project.id,
      await itemIds(),
    );
    expect(outcome.confirmed).toBe(1);
    expect(outcome.proposed).toBe(0);

    const graph = await links.listForProject(pool, project.id);
    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({
      fromMemoryKey: 'database.migrations',
      relation: 'relates_to',
      toMemoryKey: 'decision.schema',
      state: 'confirmed',
      source: 'deterministic',
      confidence: null,
    });
    expect(graph[0]!.metadata).toMatchObject({ matched_by: 'wikilink' });
  });

  it('writes a bare key mention as confirmed too', async () => {
    await publish([
      entry({ memory_key: 'run.api', body: 'The API reads its pool from database.primary.' }),
      entry({ memory_key: 'database.primary', body: 'PostgreSQL 15.' }),
    ]);

    await relationService(new NullRelationProposer()).inferForItems(project.id, await itemIds());

    const graph = await links.listForProject(pool, project.id);
    expect(graph).toHaveLength(1);
    expect(graph[0]!.metadata).toMatchObject({ matched_by: 'mention' });
    expect(graph[0]!.source).toBe('deterministic');
  });

  it('never links an entry to itself when it names its own key', async () => {
    await publish([
      entry({ memory_key: 'run.api', body: 'run.api is the entry point. See [[run.api]].' }),
      entry({ memory_key: 'other.thing', body: 'Unrelated.' }),
    ]);

    const outcome = await relationService(new NullRelationProposer()).inferForItems(
      project.id,
      await itemIds(),
    );
    expect(outcome.confirmed).toBe(0);
    expect(await links.listForProject(pool, project.id)).toEqual([]);
  });

  it('is idempotent: a second pass writes nothing', async () => {
    await publish([
      entry({ memory_key: 'a.one', body: 'See [[a.two]].' }),
      entry({ memory_key: 'a.two', body: 'Nothing here.' }),
    ]);
    const service = relationService(new NullRelationProposer());

    const first = await service.inferForItems(project.id, await itemIds());
    const second = await service.inferForItems(project.id, await itemIds());

    expect(first.confirmed).toBe(1);
    expect(second.confirmed).toBe(0);
    expect(await links.listForProject(pool, project.id)).toHaveLength(1);
  });
});

describe('model relations', () => {
  it('writes what the model infers as a proposal, not into the graph', async () => {
    await publish([
      entry({ memory_key: 'server.api', body: 'Fastify, one process.' }),
      entry({ memory_key: 'database.primary', body: 'PostgreSQL 15.' }),
    ]);
    await embedAll();

    const proposer = new ScriptedProposer({
      'server.api': [
        {
          toMemoryKey: 'database.primary',
          relation: 'depends_on',
          confidence: 0.9,
          rationale: 'The API stores everything in it.',
        },
      ],
    });

    const outcome = await relationService(proposer).inferForItems(project.id, await itemIds());
    expect(outcome.proposed).toBe(1);

    // Invisible to every reader that means "the graph".
    expect(await links.listForProject(pool, project.id)).toEqual([]);

    const pending = await links.listForProject(pool, project.id, 'proposed');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      fromMemoryKey: 'server.api',
      relation: 'depends_on',
      toMemoryKey: 'database.primary',
      state: 'proposed',
      source: 'model',
      confidence: 0.9,
      rationale: 'The API stores everything in it.',
    });
  });

  it('drops a proposal below the confidence floor', async () => {
    await publish([
      entry({ memory_key: 'server.api', body: 'Fastify, one process.' }),
      entry({ memory_key: 'database.primary', body: 'PostgreSQL 15.' }),
    ]);
    await embedAll();

    const proposer = new ScriptedProposer({
      'server.api': [
        {
          toMemoryKey: 'database.primary',
          relation: 'uses',
          confidence: 0.2,
          rationale: 'A guess.',
        },
      ],
    });

    const outcome = await relationService(proposer, 0.6).inferForItems(project.id, await itemIds());
    expect(outcome.proposed).toBe(0);
    expect(outcome.belowConfidence).toBe(1);
    expect(await links.listForProject(pool, project.id, 'proposed')).toEqual([]);
  });

  it('offers no candidates when nothing is embedded yet', async () => {
    await publish([
      entry({ memory_key: 'server.api', body: 'Fastify.' }),
      entry({ memory_key: 'database.primary', body: 'PostgreSQL 15.' }),
    ]);
    // Deliberately not embedded: the embedding job has not caught up.

    const proposer = new ScriptedProposer();
    await relationService(proposer).inferForItems(project.id, await itemIds());
    expect(proposer.seen).toEqual([]);
  });

  it('keeps the deterministic half when the model is unreachable', async () => {
    await publish([
      entry({ memory_key: 'database.migrations', body: 'See [[decision.schema]].' }),
      entry({ memory_key: 'decision.schema', body: 'Schema decisions live here.' }),
    ]);
    await embedAll();

    const outcome = await relationService(new FailingProposer()).inferForItems(
      project.id,
      await itemIds(),
    );

    expect(outcome.proposerError).toBe('the model server is down');
    expect(outcome.confirmed).toBe(1);
    expect(await links.listForProject(pool, project.id)).toHaveLength(1);
  });

  it('does not re-propose a relation a person rejected', async () => {
    await publish([
      entry({ memory_key: 'server.api', body: 'Fastify.' }),
      entry({ memory_key: 'database.primary', body: 'PostgreSQL 15.' }),
    ]);
    await embedAll();

    const proposer = new ScriptedProposer({
      'server.api': [
        {
          toMemoryKey: 'database.primary',
          relation: 'depends_on',
          confidence: 0.9,
          rationale: 'A guess somebody disagrees with.',
        },
      ],
    });
    const service = relationService(proposer);

    await service.inferForItems(project.id, await itemIds());
    const [pending] = await links.listForProject(pool, project.id, 'proposed');
    await links.reject(pool, pending!.id);

    // The rejection has to survive the job running again, which it does on every publish.
    const second = await service.inferForItems(project.id, await itemIds());
    expect(second.proposed).toBe(0);
    expect(await links.listForProject(pool, project.id, 'proposed')).toEqual([]);
    expect(await links.listForProject(pool, project.id)).toEqual([]);
  });

  it('lets a person create by hand the relation they rejected', async () => {
    await publish([
      entry({ memory_key: 'server.api', body: 'Fastify.' }),
      entry({ memory_key: 'database.primary', body: 'PostgreSQL 15.' }),
    ]);
    await embedAll();

    const proposer = new ScriptedProposer({
      'server.api': [
        {
          toMemoryKey: 'database.primary',
          relation: 'depends_on',
          confidence: 0.9,
          rationale: 'Right relation, wrong direction.',
        },
      ],
    });
    await relationService(proposer).inferForItems(project.id, await itemIds());
    const [pending] = await links.listForProject(pool, project.id, 'proposed');
    await links.reject(pool, pending!.id);

    // A tombstone must not permanently forbid the relation — it only stops the model retrying.
    const created = await links.create(pool, {
      projectId: project.id,
      fromMemoryItemId: pending!.fromMemoryItemId,
      relation: 'depends_on',
      toMemoryItemId: pending!.toMemoryItemId,
      metadata: {},
    });
    expect(created).toMatchObject({
      state: 'confirmed',
      source: 'human',
      confidence: null,
      rationale: null,
    });
    expect(await links.listForProject(pool, project.id)).toHaveLength(1);
  });

  it('does not re-propose a relation a person already confirmed', async () => {
    await publish([
      entry({ memory_key: 'server.api', body: 'Fastify.' }),
      entry({ memory_key: 'database.primary', body: 'PostgreSQL 15.' }),
    ]);
    await embedAll();

    const proposer = new ScriptedProposer({
      'server.api': [
        {
          toMemoryKey: 'database.primary',
          relation: 'depends_on',
          confidence: 0.9,
          rationale: 'Stated in the body.',
        },
      ],
    });
    const service = relationService(proposer);

    await service.inferForItems(project.id, await itemIds());
    const [pending] = await links.listForProject(pool, project.id, 'proposed');
    await links.confirm(pool, pending!.id);

    const second = await service.inferForItems(project.id, await itemIds());
    expect(second.proposed).toBe(0);
    expect(await links.listForProject(pool, project.id)).toHaveLength(1);
  });
});

describe('publication', () => {
  it('queues relation inference in the publish transaction', async () => {
    const updateId = await publish([entry({ memory_key: 'a.one' })]);

    const queued = await pool.query<{ job_type: string; payload: { memory_update_id: string } }>(
      `SELECT job_type, payload FROM shrine.jobs WHERE job_type = 'relation_inference'`,
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]!.payload.memory_update_id).toBe(updateId);
  });

  it('infers over exactly the entries an update published', async () => {
    await publish([
      entry({ memory_key: 'a.one', body: 'See [[a.two]].' }),
      entry({ memory_key: 'a.two', body: 'Nothing here.' }),
    ]);
    const secondUpdate = await publish([
      entry({ memory_key: 'a.three', body: 'Also see [[a.two]].' }),
    ]);

    const outcome = await relationService(new NullRelationProposer()).inferForUpdate(secondUpdate);
    // Only `a.three` was scanned, so only its relation was written — `a.one`'s is not this
    // update's business.
    expect(outcome.scanned).toBe(1);
    expect(outcome.confirmed).toBe(1);
    const graph = await links.listForProject(pool, project.id);
    expect(graph.map((link) => link.fromMemoryKey)).toEqual(['a.three']);
  });

  it('fails permanently for an update that no longer exists', async () => {
    await expect(
      relationService(new NullRelationProposer()).inferForUpdate(
        '00000000-0000-0000-0000-000000000000',
      ),
    ).rejects.toThrow(/No such Lore update/);
  });
});
