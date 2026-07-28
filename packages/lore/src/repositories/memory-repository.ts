import type {
  EvidenceItem,
  MemoryCategory,
  MemoryKind,
  MemoryState,
  MemoryUpdateState,
  VerificationState,
  Volatility,
} from '@saga/contracts';
import type { Queryable } from '@saga/database';
import { isUniqueViolation, sortedIds, toVectorLiteral } from '@saga/database';
import { SagaError } from '@saga/shared';
import type {
  EmbeddingState,
  MemoryItem,
  MemoryItemWithVersion,
  MemoryUpdate,
  MemoryUpdateItem,
  MemoryVersion,
} from '../domain/lore.js';

// --- row shapes ------------------------------------------------------------

interface ItemRow {
  id: string;
  project_id: string;
  memory_key: string;
  category: string;
  kind: string;
  state: string;
  importance: number;
  volatility: string;
  current_version_id: string | null;
  last_verified_at: Date | null;
  stale_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  memory_item_id: string;
  memory_update_id: string | null;
  base_version_id: string | null;
  body: string;
  data: Record<string, unknown>;
  evidence: EvidenceItem[];
  content_hash: string;
  confidence: number;
  verification_state: string;
  embedding_state: string;
  embedding_model: string | null;
  created_by_session_id: string | null;
  created_at: Date;
  ready_at: Date | null;
}

const ITEM_COLUMNS = `id, project_id, memory_key, category, kind, state, importance, volatility,
                      current_version_id, last_verified_at, stale_reason, created_at, updated_at`;

const VERSION_COLUMNS = `id, memory_item_id, memory_update_id, base_version_id, body, data,
                         evidence, content_hash, confidence, verification_state,
                         embedding_state, embedding_model, created_by_session_id,
                         created_at, ready_at`;

function toItem(row: ItemRow): MemoryItem {
  return {
    id: row.id,
    projectId: row.project_id,
    memoryKey: row.memory_key,
    category: row.category as MemoryCategory,
    kind: row.kind as MemoryKind,
    state: row.state as MemoryState,
    importance: row.importance,
    volatility: row.volatility as Volatility,
    currentVersionId: row.current_version_id,
    lastVerifiedAt: row.last_verified_at,
    staleReason: row.stale_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVersion(row: VersionRow): MemoryVersion {
  return {
    id: row.id,
    memoryItemId: row.memory_item_id,
    memoryUpdateId: row.memory_update_id,
    baseVersionId: row.base_version_id,
    body: row.body,
    data: row.data,
    evidence: row.evidence,
    contentHash: row.content_hash,
    confidence: Number(row.confidence),
    verificationState: row.verification_state as VerificationState,
    embeddingState: row.embedding_state as EmbeddingState,
    embeddingModel: row.embedding_model,
    createdBySessionId: row.created_by_session_id,
    createdAt: row.created_at,
    readyAt: row.ready_at,
  };
}

export interface UpsertItemInput {
  projectId: string;
  memoryKey: string;
  category: MemoryCategory;
  kind: MemoryKind;
  importance: number;
  volatility: Volatility;
}

export interface InsertVersionInput {
  memoryItemId: string;
  memoryUpdateId: string;
  baseVersionId: string | null;
  body: string;
  data: Record<string, unknown>;
  evidence: EvidenceItem[];
  contentHash: string;
  confidence: number;
  verificationState: VerificationState;
  /** Text fed to the full-text index; the caller composes key + body + data. */
  searchText: string;
  createdBySessionId: string | null;
}

export class MemoryRepository {
  // --- items ---------------------------------------------------------------

  /**
   * Find-or-create the identity row. Identity metadata (category, kind, importance) is
   * refreshed, but the current-version pointer is never touched here — only a publish
   * transaction may move it.
   */
  async upsertItem(tx: Queryable, input: UpsertItemInput): Promise<MemoryItem> {
    const result = await tx.query<ItemRow>(
      `INSERT INTO lore.memory_items
         (project_id, memory_key, category, kind, importance, volatility)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, memory_key) DO UPDATE
         SET category = EXCLUDED.category,
             kind = EXCLUDED.kind,
             importance = EXCLUDED.importance,
             volatility = EXCLUDED.volatility,
             updated_at = now()
       RETURNING ${ITEM_COLUMNS}`,
      [
        input.projectId,
        input.memoryKey,
        input.category,
        input.kind,
        input.importance,
        input.volatility,
      ],
    );
    return toItem(result.rows[0]!);
  }

  async findItemByKey(
    q: Queryable,
    projectId: string,
    memoryKey: string,
  ): Promise<MemoryItem | null> {
    const result = await q.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM lore.memory_items WHERE project_id = $1 AND memory_key = $2`,
      [projectId, memoryKey],
    );
    return result.rows[0] === undefined ? null : toItem(result.rows[0]);
  }

  async findItemById(q: Queryable, id: string): Promise<MemoryItem | null> {
    const result = await q.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM lore.memory_items WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toItem(result.rows[0]);
  }

  /**
   * Lock the given items for update **in ascending id order**. Deterministic ordering is what
   * prevents two concurrent publishes that share items from deadlocking.
   */
  async lockItems(tx: Queryable, ids: readonly string[]): Promise<MemoryItem[]> {
    if (ids.length === 0) return [];
    const ordered = sortedIds(ids);
    const result = await tx.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM lore.memory_items
        WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [ordered],
    );
    return result.rows.map(toItem);
  }

  async listItems(
    q: Queryable,
    filter: {
      projectId: string;
      category?: MemoryCategory;
      kind?: MemoryKind;
      state?: MemoryState;
      verificationState?: VerificationState;
      volatility?: Volatility;
      minImportance?: number;
      includeArchived?: boolean;
      cursorKey?: string;
      cursorId?: string;
      limit: number;
    },
  ): Promise<MemoryItemWithVersion[]> {
    const conditions = ['i.project_id = $1'];
    const values: unknown[] = [filter.projectId];

    const push = (fragment: (index: number) => string, value: unknown) => {
      values.push(value);
      conditions.push(fragment(values.length));
    };

    if (filter.category !== undefined) push((i) => `i.category = $${i}`, filter.category);
    if (filter.kind !== undefined) push((i) => `i.kind = $${i}`, filter.kind);
    if (filter.state !== undefined) push((i) => `i.state = $${i}`, filter.state);
    else if (filter.includeArchived !== true) conditions.push(`i.state <> 'archived'`);
    if (filter.volatility !== undefined) push((i) => `i.volatility = $${i}`, filter.volatility);
    if (filter.minImportance !== undefined)
      push((i) => `i.importance >= $${i}`, filter.minImportance);
    if (filter.verificationState !== undefined) {
      push((i) => `v.verification_state = $${i}`, filter.verificationState);
    }
    if (filter.cursorKey !== undefined && filter.cursorId !== undefined) {
      values.push(filter.cursorKey, filter.cursorId);
      conditions.push(`(i.memory_key, i.id) > ($${values.length - 1}, $${values.length})`);
    }

    values.push(filter.limit);
    const result = await q.query<ItemRow & Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS.split(',')
        .map((column) => `i.${column.trim()}`)
        .join(', ')},
              ${VERSION_COLUMNS.split(',')
                .map((column) => `v.${column.trim()} AS v_${column.trim()}`)
                .join(', ')}
         FROM lore.memory_items i
         LEFT JOIN lore.memory_versions v ON v.id = i.current_version_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY i.memory_key, i.id
        LIMIT $${values.length}`,
      values,
    );

    return result.rows.map((row) => ({
      ...toItem(row),
      currentVersion: row.v_id == null ? null : toVersion(extractVersion(row)),
    }));
  }

  async findItemWithVersion(
    q: Queryable,
    projectId: string,
    memoryKey: string,
  ): Promise<MemoryItemWithVersion | null> {
    const result = await q.query<ItemRow & Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS.split(',')
        .map((column) => `i.${column.trim()}`)
        .join(', ')},
              ${VERSION_COLUMNS.split(',')
                .map((column) => `v.${column.trim()} AS v_${column.trim()}`)
                .join(', ')}
         FROM lore.memory_items i
         LEFT JOIN lore.memory_versions v ON v.id = i.current_version_id
        WHERE i.project_id = $1 AND i.memory_key = $2`,
      [projectId, memoryKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ...toItem(row),
      currentVersion: row.v_id == null ? null : toVersion(extractVersion(row)),
    };
  }

  /** Load current versions for a set of item ids, keyed by item id. */
  async currentVersionsFor(
    q: Queryable,
    itemIds: readonly string[],
  ): Promise<Map<string, MemoryVersion>> {
    const map = new Map<string, MemoryVersion>();
    if (itemIds.length === 0) return map;
    const result = await q.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM lore.memory_versions v
        WHERE v.id IN (SELECT current_version_id FROM lore.memory_items WHERE id = ANY($1::uuid[]))`,
      [[...itemIds]],
    );
    for (const row of result.rows) map.set(row.memory_item_id, toVersion(row));
    return map;
  }

  async setCurrentVersion(
    tx: Queryable,
    itemId: string,
    versionId: string,
    verifiedAt: Date | null,
  ): Promise<void> {
    await tx.query(
      `UPDATE lore.memory_items
          SET current_version_id = $2,
              state = 'active',
              stale_reason = NULL,
              last_verified_at = COALESCE($3, last_verified_at),
              updated_at = now()
        WHERE id = $1`,
      [itemId, versionId, verifiedAt],
    );
  }

  async markStale(tx: Queryable, itemId: string, reason: string): Promise<MemoryItem | null> {
    const result = await tx.query<ItemRow>(
      `UPDATE lore.memory_items
          SET state = 'stale', stale_reason = $2, updated_at = now()
        WHERE id = $1 AND state = 'active'
       RETURNING ${ITEM_COLUMNS}`,
      [itemId, reason],
    );
    return result.rows[0] === undefined ? null : toItem(result.rows[0]);
  }

  async archiveItem(tx: Queryable, itemId: string): Promise<MemoryItem | null> {
    const result = await tx.query<ItemRow>(
      `UPDATE lore.memory_items
          SET state = 'archived', stale_reason = NULL, updated_at = now()
        WHERE id = $1 AND state <> 'archived'
       RETURNING ${ITEM_COLUMNS}`,
      [itemId],
    );
    return result.rows[0] === undefined ? null : toItem(result.rows[0]);
  }

  async countsForProjects(
    q: Queryable,
    projectIds: readonly string[],
  ): Promise<Map<string, { entries: number; stale: number }>> {
    const map = new Map<string, { entries: number; stale: number }>();
    if (projectIds.length === 0) return map;
    const result = await q.query<{ project_id: string; entries: string; stale: string }>(
      `SELECT project_id,
              count(*) FILTER (WHERE state <> 'archived')::text AS entries,
              count(*) FILTER (WHERE state = 'stale')::text AS stale
         FROM lore.memory_items
        WHERE project_id = ANY($1::uuid[])
        GROUP BY project_id`,
      [[...projectIds]],
    );
    for (const row of result.rows) {
      map.set(row.project_id, { entries: Number(row.entries), stale: Number(row.stale) });
    }
    return map;
  }

  async totals(q: Queryable): Promise<{ entries: number; stale: number }> {
    const result = await q.query<{ entries: string; stale: string }>(
      `SELECT count(*) FILTER (WHERE state <> 'archived')::text AS entries,
              count(*) FILTER (WHERE state = 'stale')::text AS stale
         FROM lore.memory_items`,
    );
    const row = result.rows[0]!;
    return { entries: Number(row.entries), stale: Number(row.stale) };
  }

  // --- versions ------------------------------------------------------------

  async insertVersion(tx: Queryable, input: InsertVersionInput): Promise<MemoryVersion> {
    const result = await tx.query<VersionRow>(
      `INSERT INTO lore.memory_versions
         (memory_item_id, memory_update_id, base_version_id, body, data, evidence,
          content_hash, confidence, verification_state, search_document, created_by_session_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9,
               to_tsvector('english', $10), $11)
       RETURNING ${VERSION_COLUMNS}`,
      [
        input.memoryItemId,
        input.memoryUpdateId,
        input.baseVersionId,
        input.body,
        JSON.stringify(input.data),
        JSON.stringify(input.evidence),
        input.contentHash,
        input.confidence,
        input.verificationState,
        input.searchText,
        input.createdBySessionId,
      ],
    );
    return toVersion(result.rows[0]!);
  }

  async findVersionById(q: Queryable, id: string): Promise<MemoryVersion | null> {
    const result = await q.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM lore.memory_versions WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toVersion(result.rows[0]);
  }

  async listVersionsForItem(q: Queryable, itemId: string, limit: number): Promise<MemoryVersion[]> {
    const result = await q.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM lore.memory_versions
        WHERE memory_item_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [itemId, limit],
    );
    return result.rows.map(toVersion);
  }

  /**
   * Worker-owned write. The embedding fields and `ready_at` are the *only* parts of a version
   * that may change after insertion.
   */
  async setEmbedding(
    q: Queryable,
    versionId: string,
    embedding: readonly number[],
    model: string,
  ): Promise<boolean> {
    const result = await q.query(
      `UPDATE lore.memory_versions
          SET embedding = $2::vector, embedding_state = 'ready', embedding_model = $3,
              ready_at = COALESCE(ready_at, now())
        WHERE id = $1`,
      [versionId, toVectorLiteral(embedding), model],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async setEmbeddingState(q: Queryable, versionId: string, state: EmbeddingState): Promise<void> {
    await q.query(`UPDATE lore.memory_versions SET embedding_state = $2 WHERE id = $1`, [
      versionId,
      state,
    ]);
  }

  async embeddingStatesFor(
    q: Queryable,
    versionIds: readonly string[],
  ): Promise<Map<string, EmbeddingState>> {
    const map = new Map<string, EmbeddingState>();
    if (versionIds.length === 0) return map;
    const result = await q.query<{ id: string; embedding_state: string }>(
      `SELECT id, embedding_state FROM lore.memory_versions WHERE id = ANY($1::uuid[])`,
      [[...versionIds]],
    );
    for (const row of result.rows) map.set(row.id, row.embedding_state as EmbeddingState);
    return map;
  }

  // --- updates -------------------------------------------------------------

  async createUpdate(
    tx: Queryable,
    input: {
      projectId: string;
      summary: string;
      createdBySessionId: string | null;
      correlationId: string | null;
    },
  ): Promise<MemoryUpdate> {
    const result = await tx.query<UpdateRow>(
      `INSERT INTO lore.memory_updates (project_id, summary, created_by_session_id, correlation_id)
       VALUES ($1, $2, $3, $4) RETURNING ${UPDATE_COLUMNS}`,
      [input.projectId, input.summary, input.createdBySessionId, input.correlationId],
    );
    return toUpdate(result.rows[0]!);
  }

  async findUpdateById(q: Queryable, id: string): Promise<MemoryUpdate | null> {
    const result = await q.query<UpdateRow>(
      `SELECT ${UPDATE_COLUMNS} FROM lore.memory_updates WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toUpdate(result.rows[0]);
  }

  async lockUpdateById(tx: Queryable, id: string): Promise<MemoryUpdate | null> {
    const result = await tx.query<UpdateRow>(
      `SELECT ${UPDATE_COLUMNS} FROM lore.memory_updates WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] === undefined ? null : toUpdate(result.rows[0]);
  }

  async setUpdateState(
    tx: Queryable,
    id: string,
    state: MemoryUpdateState,
    fields: { error?: string | null; preparedSnapshotId?: string | null } = {},
  ): Promise<MemoryUpdate> {
    const timestampColumn: Partial<Record<MemoryUpdateState, string>> = {
      validating: 'validating_at',
      ready: 'ready_at',
      published: 'published_at',
      cancelled: 'cancelled_at',
    };
    const stamp = timestampColumn[state];

    const assignments = [`state = $2`, `error = $3`];
    const values: unknown[] = [id, state, fields.error ?? null];
    if (stamp !== undefined) assignments.push(`${stamp} = now()`);
    if (fields.preparedSnapshotId !== undefined) {
      values.push(fields.preparedSnapshotId);
      assignments.push(`prepared_snapshot_id = $${values.length}`);
    }

    const result = await tx.query<UpdateRow>(
      `UPDATE lore.memory_updates SET ${assignments.join(', ')} WHERE id = $1
       RETURNING ${UPDATE_COLUMNS}`,
      values,
    );
    if (result.rows[0] === undefined) {
      throw new SagaError('MEMORY_UPDATE_NOT_FOUND', 'The Lore update no longer exists.');
    }
    return toUpdate(result.rows[0]);
  }

  async listUpdates(
    q: Queryable,
    filter: { projectId: string; state?: MemoryUpdateState; limit: number },
  ): Promise<MemoryUpdate[]> {
    const values: unknown[] = [filter.projectId];
    let where = 'project_id = $1';
    if (filter.state !== undefined) {
      values.push(filter.state);
      where += ` AND state = $${values.length}`;
    }
    values.push(filter.limit);
    const result = await q.query<UpdateRow>(
      `SELECT ${UPDATE_COLUMNS} FROM lore.memory_updates WHERE ${where}
        ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(toUpdate);
  }

  async addUpdateItem(
    tx: Queryable,
    input: {
      memoryUpdateId: string;
      memoryItemId: string;
      baseVersionId: string | null;
      candidateVersionId: string;
    },
  ): Promise<void> {
    try {
      await tx.query(
        `INSERT INTO lore.memory_update_items
           (memory_update_id, memory_item_id, base_version_id, candidate_version_id)
         VALUES ($1, $2, $3, $4)`,
        [input.memoryUpdateId, input.memoryItemId, input.baseVersionId, input.candidateVersionId],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SagaError(
          'VALIDATION_FAILED',
          'The same Lore Entry appears twice in one update. Merge the entries into a single proposal.',
        );
      }
      throw error;
    }
  }

  async listUpdateItems(q: Queryable, updateId: string): Promise<MemoryUpdateItem[]> {
    const result = await q.query<{
      memory_update_id: string;
      memory_item_id: string;
      memory_key: string;
      base_version_id: string | null;
      candidate_version_id: string;
    }>(
      `SELECT ui.memory_update_id, ui.memory_item_id, i.memory_key,
              ui.base_version_id, ui.candidate_version_id
         FROM lore.memory_update_items ui
         JOIN lore.memory_items i ON i.id = ui.memory_item_id
        WHERE ui.memory_update_id = $1
        ORDER BY i.memory_key`,
      [updateId],
    );
    return result.rows.map((row) => ({
      memoryUpdateId: row.memory_update_id,
      memoryItemId: row.memory_item_id,
      memoryKey: row.memory_key,
      baseVersionId: row.base_version_id,
      candidateVersionId: row.candidate_version_id,
    }));
  }
}

// --- update row helpers ----------------------------------------------------

interface UpdateRow {
  id: string;
  project_id: string;
  created_by_session_id: string | null;
  state: string;
  summary: string;
  error: string | null;
  created_at: Date;
  validating_at: Date | null;
  ready_at: Date | null;
  published_at: Date | null;
  cancelled_at: Date | null;
  prepared_snapshot_id: string | null;
  correlation_id: string | null;
}

const UPDATE_COLUMNS = `id, project_id, created_by_session_id, state, summary, error, created_at,
                        validating_at, ready_at, published_at, cancelled_at,
                        prepared_snapshot_id, correlation_id`;

function toUpdate(row: UpdateRow): MemoryUpdate {
  return {
    id: row.id,
    projectId: row.project_id,
    createdBySessionId: row.created_by_session_id,
    state: row.state as MemoryUpdateState,
    summary: row.summary,
    error: row.error,
    createdAt: row.created_at,
    validatingAt: row.validating_at,
    readyAt: row.ready_at,
    publishedAt: row.published_at,
    cancelledAt: row.cancelled_at,
    preparedSnapshotId: row.prepared_snapshot_id,
    correlationId: row.correlation_id,
  };
}

/** Rebuild a version row from a `v_`-prefixed join projection. */
function extractVersion(row: Record<string, unknown>): VersionRow {
  const out: Record<string, unknown> = {};
  for (const column of VERSION_COLUMNS.split(',')) {
    const name = column.trim();
    out[name] = row[`v_${name}`];
  }
  return out as unknown as VersionRow;
}
