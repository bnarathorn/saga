import type { SagaPool } from '@saga/database';
import { SagaError } from '@saga/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, createTestServices, truncateAll } from '../../../../testing/harness.js';
import type { ProjectService } from './project-service.js';

let pool: SagaPool;
let projects: ProjectService;
let services: ReturnType<typeof createTestServices>;

beforeEach(async () => {
  pool ??= createTestPool('saga-core-test');
  services ??= createTestServices({ pool });
  projects = services.projects;
  await truncateAll(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe('project identity', () => {
  it('creates a project from a name alone', async () => {
    const project = await projects.create({ name: 'ERP Backoffice' });
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.name).toBe('ERP Backoffice');
    expect(project.nameKey).toBe('erp backoffice');
    expect(project.memoryRevision).toBe(0);
    expect(project.activeContextSnapshotId).toBeNull();
  });

  it('rejects names that normalise to an existing project', async () => {
    await projects.create({ name: 'ERP Backoffice' });
    for (const duplicate of ['erp backoffice', 'ERP Backoffice ', '  ERP   Backoffice  ', 'ＥＲＰ Backoffice']) {
      await expect(projects.create({ name: duplicate })).rejects.toMatchObject({
        code: 'PROJECT_NAME_CONFLICT',
      });
    }
    const page = await projects.list({ limit: 50 });
    expect(page.items).toHaveLength(1);
  });

  it('resolves by uuid, name, normalized name and alias', async () => {
    const created = await projects.create({ name: 'Payment Gateway' });
    for (const ref of [created.id, 'Payment Gateway', 'payment gateway', '  PAYMENT   gateway ']) {
      const resolved = await projects.resolve(ref);
      expect(resolved.id, `ref: ${ref}`).toBe(created.id);
    }
    await expect(projects.resolve('No Such Project')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });
});

describe('rename', () => {
  it('preserves the uuid and records the previous name as an alias', async () => {
    const created = await projects.create({ name: 'ERP Backoffice' });
    const renamed = await projects.update('ERP Backoffice', { name: 'ERP Back Office' });

    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe('ERP Back Office');
    expect(renamed.aliases).toEqual(['ERP Backoffice']);

    const viaAlias = await projects.resolve('erp backoffice');
    expect(viaAlias.id).toBe(created.id);
  });

  it('writes the alias in the same transaction as the rename', async () => {
    const created = await projects.create({ name: 'Alpha' });
    await projects.update('Alpha', { name: 'Beta' });
    const rows = await pool.query<{ alias: string; alias_key: string }>(
      'SELECT alias, alias_key FROM core.project_aliases WHERE project_id = $1',
      [created.id],
    );
    expect(rows.rows).toEqual([{ alias: 'Alpha', alias_key: 'alpha' }]);
  });

  it('rejects a rename that collides with another project name', async () => {
    await projects.create({ name: 'Alpha' });
    await projects.create({ name: 'Beta' });
    await expect(projects.update('Alpha', { name: 'beta' })).rejects.toMatchObject({
      code: 'PROJECT_NAME_CONFLICT',
    });
    // The failed rename must leave the original name untouched.
    expect((await projects.resolve('Alpha')).name).toBe('Alpha');
  });

  it("rejects a name that is another project's former name", async () => {
    await projects.create({ name: 'Alpha' });
    await projects.update('Alpha', { name: 'Gamma' });
    await expect(projects.create({ name: 'Alpha' })).rejects.toMatchObject({
      code: 'PROJECT_NAME_CONFLICT',
    });
  });

  it('lets a project reclaim its own former name', async () => {
    const created = await projects.create({ name: 'Alpha' });
    await projects.update('Alpha', { name: 'Gamma' });
    const back = await projects.update('Gamma', { name: 'Alpha' });
    expect(back.id).toBe(created.id);
    expect(back.name).toBe('Alpha');
    expect(back.aliases.sort()).toEqual(['Alpha', 'Gamma']);
  });

  it('does not create an alias when only the description changes', async () => {
    await projects.create({ name: 'Alpha' });
    const updated = await projects.update('Alpha', { description: 'now with a description' });
    expect(updated.aliases).toEqual([]);
    expect(updated.description).toBe('now with a description');
  });
});

describe('archive and restore', () => {
  it('makes an archived project read-only, then restores it', async () => {
    await projects.create({ name: 'Legacy System' });
    const archived = await projects.archive('Legacy System', 'decommissioned');
    expect(archived.status).toBe('archived');

    await expect(projects.update('Legacy System', { name: 'Anything' })).rejects.toMatchObject({
      code: 'PROJECT_ARCHIVED',
    });
    await expect(projects.requireActive('Legacy System')).rejects.toThrow(SagaError);

    const restored = await projects.restore('Legacy System', 'needed again');
    expect(restored.status).toBe('active');
    await expect(projects.requireActive('Legacy System')).resolves.toMatchObject({ status: 'active' });
  });

  it('is idempotent when archiving twice', async () => {
    await projects.create({ name: 'Legacy System' });
    await projects.archive('Legacy System', 'first');
    const again = await projects.archive('Legacy System', 'second');
    expect(again.status).toBe('archived');
  });
});

describe('outbox atomicity', () => {
  it('commits the domain event with the mutation', async () => {
    const project = await projects.create({ name: 'Event Project' });
    const events = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
      'SELECT topic, payload FROM core.outbox_events WHERE project_id = $1 ORDER BY created_at',
      [project.id],
    );
    expect(events.rows.map((row) => row.topic)).toEqual(['core.project_created']);
    expect(events.rows[0]?.payload).toMatchObject({ name: 'Event Project' });
  });

  it('writes no event when the mutation fails', async () => {
    await projects.create({ name: 'Alpha' });
    const before = await pool.query<{ count: string }>('SELECT count(*)::text FROM core.outbox_events');
    await expect(projects.create({ name: 'alpha' })).rejects.toThrow();
    const after = await pool.query<{ count: string }>('SELECT count(*)::text FROM core.outbox_events');
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

describe('pagination', () => {
  it('walks the whole list exactly once with a stable cursor', async () => {
    const names = ['Delta', 'Alpha', 'Echo', 'Bravo', 'Charlie'];
    for (const name of names) await projects.create({ name });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await projects.list({ limit: 2, cursor });
      seen.push(...page.items.map((item) => item.name));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toEqual([...names].sort());
    expect(new Set(seen).size).toBe(names.length);
  });

  it('filters by status and search term', async () => {
    await projects.create({ name: 'Payment Gateway' });
    await projects.create({ name: 'Customer Portal' });
    await projects.archive('Customer Portal', 'done');

    const active = await projects.list({ limit: 50, status: 'active' });
    expect(active.items.map((item) => item.name)).toEqual(['Payment Gateway']);

    const search = await projects.list({ limit: 50, search: 'portal' });
    expect(search.items.map((item) => item.name)).toEqual(['Customer Portal']);
  });
});
