import type { MemoryLinkSource, MemoryLinkState, MemoryRelation } from '@saga/contracts';
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
  state: string;
  source: string;
  confidence: number | null;
  rationale: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const SELECT = `SELECT l.id, l.project_id, l.from_memory_item_id, f.memory_key AS from_memory_key,
                       l.relation, l.to_memory_item_id, t.memory_key AS to_memory_key,
                       l.state, l.source, l.confidence, l.rationale,
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
    state: row.state as MemoryLinkState,
    source: row.source as MemoryLinkSource,
    confidence: row.confidence,
    rationale: row.rationale,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

/** One relation the inference job wants to write. */
export interface InferredLinkInput {
  projectId: string;
  fromMemoryItemId: string;
  relation: MemoryRelation;
  toMemoryItemId: string;
  /** `deterministic` lands confirmed; `model` lands proposed. */
  source: Exclude<MemoryLinkSource, 'human'>;
  confidence?: number | null;
  rationale?: string | null;
  metadata?: Record<string, unknown>;
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
      // A rejected row is a tombstone, not a relation, so creating the same relation by hand
      // revives it rather than colliding with it — otherwise turning down one model proposal
      // would permanently block a person from ever making that link themselves.
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO lore.memory_links
           (project_id, from_memory_item_id, relation, to_memory_item_id, metadata,
            state, source)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'confirmed', 'human')
         ON CONFLICT ON CONSTRAINT memory_links_unique DO UPDATE
           SET state = 'confirmed', source = 'human', confidence = NULL, rationale = NULL,
               metadata = EXCLUDED.metadata
         WHERE lore.memory_links.state = 'rejected'
         RETURNING id`,
        [
          input.projectId,
          input.fromMemoryItemId,
          input.relation,
          input.toMemoryItemId,
          JSON.stringify(input.metadata),
        ],
      );
      // No row means the conflict target was a live relation, not a tombstone.
      if (inserted.rows[0] === undefined) {
        throw new SagaError('CONFLICT', 'That relation already exists between these two entries.');
      }
      const link = await this.findById(tx, inserted.rows[0].id);
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

  /**
   * Write relations the server inferred, without disturbing one that already exists — except
   * the one case where the text has more authority than what is on the row.
   *
   * The collision is the normal case, not an error: the job re-runs over entries it has already
   * seen on every publish. A model proposal therefore does nothing when the relation exists in
   * any state, which is what keeps a `rejected` tombstone from being re-proposed for ever.
   *
   * A deterministic match is different. It was read out of a body somebody wrote, so when it
   * collides with a *proposal* — the model guessed `relates_to` before the entry was edited to
   * say `[[key]]` outright — the proposal is confirmed rather than left in the review queue
   * behind a guess. `source` is not rewritten, for the same reason `confirm()` keeps it: who
   * suggested the relation stays true once something agrees with it. `rejected` and already
   * `confirmed` rows are untouched, so a rejection still holds.
   *
   * Self-links are dropped here too — the model is perfectly capable of proposing one, and the
   * CHECK constraint would abort the whole batch.
   */
  async insertInferred(tx: Queryable, inputs: readonly InferredLinkInput[]): Promise<MemoryLink[]> {
    const written: MemoryLink[] = [];
    for (const input of inputs) {
      if (input.fromMemoryItemId === input.toMemoryItemId) continue;
      const state: MemoryLinkState = input.source === 'model' ? 'proposed' : 'confirmed';
      const onConflict =
        input.source === 'model'
          ? 'DO NOTHING'
          : `DO UPDATE SET state = 'confirmed' WHERE memory_links.state = 'proposed'`;
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO lore.memory_links
           (project_id, from_memory_item_id, relation, to_memory_item_id, metadata,
            state, source, confidence, rationale)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
         ON CONFLICT ON CONSTRAINT memory_links_unique ${onConflict}
         RETURNING id`,
        [
          input.projectId,
          input.fromMemoryItemId,
          input.relation,
          input.toMemoryItemId,
          JSON.stringify(input.metadata ?? {}),
          state,
          input.source,
          input.source === 'model' ? (input.confidence ?? 0) : null,
          input.rationale ?? null,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) continue;
      const link = await this.findById(tx, id);
      if (link !== null) written.push(link);
    }
    return written;
  }

  async findById(q: Queryable, id: string): Promise<MemoryLink | null> {
    const result = await q.query<Row>(`${SELECT} WHERE l.id = $1`, [id]);
    return result.rows[0] === undefined ? null : toLink(result.rows[0]);
  }

  /**
   * Defaults to `confirmed`. A caller that wants the review queue has to ask for it: every
   * existing reader of this method — search expansion included — means the graph.
   */
  async listForProject(
    q: Queryable,
    projectId: string,
    state: MemoryLinkState = 'confirmed',
  ): Promise<MemoryLink[]> {
    const result = await q.query<Row>(
      `${SELECT} WHERE l.project_id = $1 AND l.state = $2
        ORDER BY f.memory_key, l.relation, t.memory_key`,
      [projectId, state],
    );
    return result.rows.map(toLink);
  }

  async listForItems(q: Queryable, itemIds: readonly string[]): Promise<MemoryLink[]> {
    if (itemIds.length === 0) return [];
    const result = await q.query<Row>(
      `${SELECT} WHERE l.state = 'confirmed'
                   AND (l.from_memory_item_id = ANY($1::uuid[])
                        OR l.to_memory_item_id = ANY($1::uuid[]))
        ORDER BY f.memory_key, l.relation, t.memory_key`,
      [[...itemIds]],
    );
    return result.rows.map(toLink);
  }

  /**
   * Accept a proposal. Confirming keeps `source = 'model'`: who suggested the relation stays
   * true after a person agrees with it, and only `state` records the agreement.
   */
  async confirm(tx: Queryable, id: string): Promise<MemoryLink | null> {
    const result = await tx.query<{ id: string }>(
      `UPDATE lore.memory_links SET state = 'confirmed'
        WHERE id = $1 AND state = 'proposed' RETURNING id`,
      [id],
    );
    if (result.rows[0] === undefined) return null;
    return this.findById(tx, id);
  }

  /**
   * Turn a proposal down, keeping the row as a tombstone.
   *
   * Deleting it instead would last exactly until the next publish: the job re-runs over the
   * same entries, the model proposes the same relation, and nothing remembers that somebody
   * already said no. The row is what `insertInferred` collides with — and neither half of it
   * revives a tombstone: the model's insert does nothing at all, and the deterministic one
   * promotes `proposed` only. `create()` is the single way back, which is a person's decision.
   */
  async reject(tx: Queryable, id: string): Promise<MemoryLink | null> {
    const result = await tx.query<{ id: string }>(
      `UPDATE lore.memory_links SET state = 'rejected'
        WHERE id = $1 AND state = 'proposed' RETURNING id`,
      [id],
    );
    if (result.rows[0] === undefined) return null;
    return this.findById(tx, id);
  }

  async delete(tx: Queryable, id: string): Promise<boolean> {
    const result = await tx.query(`DELETE FROM lore.memory_links WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) === 1;
  }
}
