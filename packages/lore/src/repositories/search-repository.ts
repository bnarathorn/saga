import type { MemoryCategory, MemoryKind, MemoryState } from '@saga/contracts';
import type { Queryable } from '@saga/database';
import { toVectorLiteral } from '@saga/database';

export interface SearchFilters {
  projectId: string;
  categories?: readonly MemoryCategory[];
  kinds?: readonly MemoryKind[];
  states?: readonly MemoryState[];
  minImportance?: number;
}

/**
 * Only current versions of non-archived items are searchable. Stale entries stay searchable
 * — they are labelled rather than hidden — but archived ones are excluded entirely.
 */
function baseConditions(filters: SearchFilters, values: unknown[]): string[] {
  const conditions: string[] = [];

  values.push(filters.projectId);
  conditions.push(`i.project_id = $${values.length}`);
  conditions.push('i.current_version_id = v.id');

  if (filters.states !== undefined && filters.states.length > 0) {
    values.push([...filters.states]);
    conditions.push(`i.state = ANY($${values.length}::text[])`);
  } else {
    conditions.push(`i.state <> 'archived'`);
  }
  if (filters.categories !== undefined && filters.categories.length > 0) {
    values.push([...filters.categories]);
    conditions.push(`i.category = ANY($${values.length}::text[])`);
  }
  if (filters.kinds !== undefined && filters.kinds.length > 0) {
    values.push([...filters.kinds]);
    conditions.push(`i.kind = ANY($${values.length}::text[])`);
  }
  if (filters.minImportance !== undefined) {
    values.push(filters.minImportance);
    conditions.push(`i.importance >= $${values.length}`);
  }

  return conditions;
}

export class SearchRepository {
  /** PostgreSQL full-text ranking over the stored `search_document` tsvector. */
  async fullText(
    q: Queryable,
    filters: SearchFilters,
    query: string,
    limit: number,
  ): Promise<string[]> {
    const values: unknown[] = [];
    const conditions = baseConditions(filters, values);
    values.push(query);
    const queryIndex = values.length;
    values.push(limit);

    const result = await q.query<{ id: string }>(
      `SELECT i.id
         FROM lore.memory_items i
         JOIN lore.memory_versions v ON v.id = i.current_version_id
        WHERE ${conditions.join(' AND ')}
          AND v.search_document @@ websearch_to_tsquery('english', $${queryIndex})
        ORDER BY ts_rank_cd(v.search_document, websearch_to_tsquery('english', $${queryIndex})) DESC,
                 i.memory_key ASC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => row.id);
  }

  /**
   * Trigram similarity. This is the channel that survives typos and partial identifiers,
   * where full-text stemming does not help.
   */
  async trigram(
    q: Queryable,
    filters: SearchFilters,
    query: string,
    limit: number,
    threshold = 0.15,
  ): Promise<string[]> {
    const values: unknown[] = [];
    const conditions = baseConditions(filters, values);
    values.push(query);
    const queryIndex = values.length;
    values.push(threshold);
    const thresholdIndex = values.length;
    values.push(limit);

    const result = await q.query<{ id: string }>(
      `SELECT i.id,
              greatest(similarity(i.memory_key, $${queryIndex}), similarity(v.body, $${queryIndex})) AS score
         FROM lore.memory_items i
         JOIN lore.memory_versions v ON v.id = i.current_version_id
        WHERE ${conditions.join(' AND ')}
          AND greatest(similarity(i.memory_key, $${queryIndex}), similarity(v.body, $${queryIndex}))
              >= $${thresholdIndex}
        ORDER BY score DESC, i.memory_key ASC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => row.id);
  }

  /**
   * Cosine similarity over ready embeddings only. A version whose embedding is still queued
   * simply does not participate, which is what lets search run before the worker catches up.
   */
  async vector(
    q: Queryable,
    filters: SearchFilters,
    embedding: readonly number[],
    limit: number,
  ): Promise<string[]> {
    const values: unknown[] = [];
    const conditions = baseConditions(filters, values);
    values.push(toVectorLiteral(embedding));
    const vectorIndex = values.length;
    values.push(limit);

    const result = await q.query<{ id: string }>(
      `SELECT i.id
         FROM lore.memory_items i
         JOIN lore.memory_versions v ON v.id = i.current_version_id
        WHERE ${conditions.join(' AND ')}
          AND v.embedding_state = 'ready'
        ORDER BY v.embedding <=> $${vectorIndex}::vector ASC, i.memory_key ASC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => row.id);
  }

  /** True when at least one searchable version in the project has a usable embedding. */
  async hasReadyEmbeddings(q: Queryable, projectId: string): Promise<boolean> {
    const result = await q.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM lore.memory_items i
          JOIN lore.memory_versions v ON v.id = i.current_version_id
         WHERE i.project_id = $1 AND i.state <> 'archived' AND v.embedding_state = 'ready'
       ) AS present`,
      [projectId],
    );
    return result.rows[0]?.present ?? false;
  }
}
