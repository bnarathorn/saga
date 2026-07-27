import type { Queryable, SagaPool } from '@saga/database';
import { buildPage, decodeCursor, type Page } from '@saga/shared';

export type ActorType = 'user' | 'agent' | 'system';

export interface AuditEntry {
  id: string;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  projectId: string | null;
  entityType: string | null;
  entityId: string | null;
  reason: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface NewAuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  projectId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

interface Row {
  id: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  project_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  reason: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const COLUMNS = `id, actor_type, actor_id, actor_label, action, project_id, entity_type,
                 entity_id, reason, request_id, metadata, created_at`;

function toEntry(row: Row): AuditEntry {
  return {
    id: row.id,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    action: row.action,
    projectId: row.project_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    requestId: row.request_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

/** Every administrative mutation is recorded here. Writes are append-only. */
export class AuditService {
  constructor(private readonly pool: SagaPool) {}

  async record(entry: NewAuditEntry, q: Queryable = this.pool): Promise<AuditEntry> {
    const result = await q.query<Row>(
      `INSERT INTO security.audit_logs
         (actor_type, actor_id, actor_label, action, project_id, entity_type, entity_id,
          reason, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING ${COLUMNS}`,
      [
        entry.actorType,
        entry.actorId ?? null,
        entry.actorLabel ?? null,
        entry.action,
        entry.projectId ?? null,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.reason ?? null,
        entry.requestId ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
    return toEntry(result.rows[0]!);
  }

  async list(filter: {
    projectId?: string;
    action?: string;
    cursor?: string;
    limit: number;
  }): Promise<Page<AuditEntry>> {
    const cursor = filter.cursor === undefined ? null : decodeCursor(filter.cursor);
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.projectId !== undefined) {
      values.push(filter.projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    if (filter.action !== undefined) {
      values.push(filter.action);
      conditions.push(`action = $${values.length}`);
    }
    if (cursor !== null) {
      values.push(cursor.k, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
    }

    values.push(filter.limit + 1);
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const result = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM security.audit_logs ${where}
        ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values,
    );
    return buildPage(result.rows.map(toEntry), filter.limit, (entry) => ({
      k: entry.createdAt.toISOString(),
      id: entry.id,
    }));
  }
}
