import type { MemoryRelation } from '@saga/contracts';
import type { Queryable } from '@saga/database';
import { isUniqueViolation } from '@saga/database';
import { SagaError } from '@saga/shared';
import type { MemoryLink } from '../domain/lore.js';

interface Row {
  id: string;
  project_id: string;
  from_memory_item_id: string;
  from_memory_key: string;
  relation: string;
  to_memory_item_id: string;
  to_memory_key: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const SELECT = `SELECT l.id, l.project_id, l.from_memory_item_id, f.memory_key AS from_memory_key,
                       l.relation, l.to_memory_item_id, t.memory_key AS to_memory_key,
                       l.metadata, l.created_at
                  FROM lore.memory_links l
                  JOIN lore.memory_items f ON f.id = l.from_memory_item_id
                  JOIN lore.memory_items t ON t.id = l.to_memory_item_id`;

function toLink(row: Row): MemoryLink {
  return {
    id: row.id,
    projectId: row.project_id,
    fromMemoryItemId: row.from_memory_item_id,
    fromMemoryKey: row.from_memory_key,
    relation: row.relation as MemoryRelation,
    toMemoryItemId: row.to_memory_item_id,
    toMemoryKey: row.to_memory_key,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export class LinkRepository {
  async create(
    tx: Queryable,
    input: {
      projectId: string;
      fromMemoryItemId: string;
      relation: MemoryRelation;
      toMemoryItemId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<MemoryLink> {
    if (input.fromMemoryItemId === input.toMemoryItemId) {
      throw new SagaError('MEMORY_LINK_INVALID', 'A Lore Entry cannot link to itself.');
    }
    try {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO lore.memory_links
           (project_id, from_memory_item_id, relation, to_memory_item_id, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
        [
          input.projectId,
          input.fromMemoryItemId,
          input.relation,
          input.toMemoryItemId,
          JSON.stringify(input.metadata),
        ],
      );
      const link = await this.findById(tx, inserted.rows[0]!.id);
      if (link === null)
        throw new SagaError('INTERNAL_ERROR', 'The link vanished after insertion.');
      return link;
    } catch (error) {
      if (isUniqueViolation(error, 'memory_links_unique')) {
        throw new SagaError('CONFLICT', 'That relation already exists between these two entries.');
      }
      throw error;
    }
  }

  async findById(q: Queryable, id: string): Promise<MemoryLink | null> {
    const result = await q.query<Row>(`${SELECT} WHERE l.id = $1`, [id]);
    return result.rows[0] === undefined ? null : toLink(result.rows[0]);
  }

  async listForProject(q: Queryable, projectId: string): Promise<MemoryLink[]> {
    const result = await q.query<Row>(
      `${SELECT} WHERE l.project_id = $1 ORDER BY f.memory_key, l.relation, t.memory_key`,
      [projectId],
    );
    return result.rows.map(toLink);
  }

  async listForItems(q: Queryable, itemIds: readonly string[]): Promise<MemoryLink[]> {
    if (itemIds.length === 0) return [];
    const result = await q.query<Row>(
      `${SELECT} WHERE l.from_memory_item_id = ANY($1::uuid[]) OR l.to_memory_item_id = ANY($1::uuid[])
        ORDER BY f.memory_key, l.relation, t.memory_key`,
      [[...itemIds]],
    );
    return result.rows.map(toLink);
  }

  async delete(tx: Queryable, id: string): Promise<boolean> {
    const result = await tx.query(`DELETE FROM lore.memory_links WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) === 1;
  }
}
