import type { Queryable } from '@saga/database';
import { isUniqueViolation } from '@saga/database';
import { SagaError } from '@saga/shared';
import type { ContextSection, ContextSnapshot, SnapshotState } from '../domain/lore.js';

interface Row {
  id: string;
  project_id: string;
  project_revision: number;
  state: string;
  sections: ContextSection[];
  rendered_context: string;
  token_count: number;
  error: string | null;
  created_at: Date;
  ready_at: Date | null;
  activated_at: Date | null;
}

const COLUMNS = `id, project_id, project_revision, state, sections, rendered_context,
                 token_count, error, created_at, ready_at, activated_at`;

function toSnapshot(row: Row): ContextSnapshot {
  return {
    id: row.id,
    projectId: row.project_id,
    projectRevision: row.project_revision,
    state: row.state as SnapshotState,
    sections: row.sections,
    renderedContext: row.rendered_context,
    tokenCount: row.token_count,
    error: row.error,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    activatedAt: row.activated_at,
  };
}

export class SnapshotRepository {
  /** Insert a snapshot in `ready` state; activation is a separate, transactional step. */
  async createReady(
    tx: Queryable,
    input: {
      projectId: string;
      projectRevision: number;
      sections: ContextSection[];
      renderedContext: string;
      tokenCount: number;
    },
  ): Promise<ContextSnapshot> {
    const result = await tx.query<Row>(
      `INSERT INTO lore.context_snapshots
         (project_id, project_revision, state, sections, rendered_context, token_count, ready_at)
       VALUES ($1, $2, 'ready', $3::jsonb, $4, $5, now())
       RETURNING ${COLUMNS}`,
      [
        input.projectId,
        input.projectRevision,
        JSON.stringify(input.sections),
        input.renderedContext,
        input.tokenCount,
      ],
    );
    return toSnapshot(result.rows[0]!);
  }

  async createFailed(
    tx: Queryable,
    input: { projectId: string; projectRevision: number; error: string },
  ): Promise<ContextSnapshot> {
    const result = await tx.query<Row>(
      `INSERT INTO lore.context_snapshots
         (project_id, project_revision, state, sections, rendered_context, token_count, error)
       VALUES ($1, $2, 'failed', '[]'::jsonb, '', 0, $3)
       RETURNING ${COLUMNS}`,
      [input.projectId, input.projectRevision, input.error],
    );
    return toSnapshot(result.rows[0]!);
  }

  async findById(q: Queryable, id: string): Promise<ContextSnapshot | null> {
    const result = await q.query<Row>(
      `SELECT ${COLUMNS} FROM lore.context_snapshots WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toSnapshot(result.rows[0]);
  }

  async findActive(q: Queryable, projectId: string): Promise<ContextSnapshot | null> {
    const result = await q.query<Row>(
      `SELECT ${COLUMNS} FROM lore.context_snapshots
        WHERE project_id = $1 AND state = 'active'`,
      [projectId],
    );
    return result.rows[0] === undefined ? null : toSnapshot(result.rows[0]);
  }

  /**
   * Flip the active snapshot. The previous active snapshot is demoted first, because a partial
   * unique index enforces at most one active snapshot per project — the database, not just the
   * service, guarantees the invariant.
   */
  async activate(tx: Queryable, projectId: string, snapshotId: string): Promise<ContextSnapshot> {
    await tx.query(
      `UPDATE lore.context_snapshots SET state = 'ready'
        WHERE project_id = $1 AND state = 'active' AND id <> $2`,
      [projectId, snapshotId],
    );

    try {
      const result = await tx.query<Row>(
        `UPDATE lore.context_snapshots
            SET state = 'active', activated_at = now()
          WHERE id = $1 AND project_id = $2 AND state IN ('ready', 'active')
         RETURNING ${COLUMNS}`,
        [snapshotId, projectId],
      );
      if (result.rows[0] === undefined) {
        throw new SagaError(
          'CONTEXT_SNAPSHOT_NOT_READY',
          'The prepared context snapshot is not in a state that can be activated.',
          { details: { snapshot_id: snapshotId } },
        );
      }
      return toSnapshot(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error, 'context_snapshots_one_active_per_project')) {
        throw new SagaError(
          'CONFLICT',
          'Another snapshot was activated for this project concurrently.',
          { details: { snapshot_id: snapshotId } },
        );
      }
      throw error;
    }
  }

  async listForProject(q: Queryable, projectId: string, limit: number): Promise<ContextSnapshot[]> {
    const result = await q.query<Row>(
      `SELECT ${COLUMNS} FROM lore.context_snapshots
        WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(toSnapshot);
  }

  /** Retention: keep the active snapshot and the most recent few per project. */
  async deleteSupersededBefore(
    q: Queryable,
    before: Date,
    keepPerProject: number,
  ): Promise<number> {
    const result = await q.query(
      `DELETE FROM lore.context_snapshots s
        WHERE s.state <> 'active'
          AND s.created_at < $1
          AND s.id NOT IN (
            SELECT id FROM (
              SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
                FROM lore.context_snapshots
            ) ranked WHERE ranked.rn <= $2
          )`,
      [before, keepPerProject],
    );
    return result.rowCount ?? 0;
  }
}
