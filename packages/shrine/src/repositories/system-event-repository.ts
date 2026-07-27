import type { Queryable } from '@saga/database';

export type SystemEventSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface SystemEvent {
  id: string;
  sequence: number;
  severity: SystemEventSeverity;
  category: string;
  projectId: string | null;
  entityType: string | null;
  entityId: string | null;
  eventType: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface NewSystemEvent {
  severity: SystemEventSeverity;
  category: string;
  projectId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}

interface Row {
  id: string;
  sequence: number;
  severity: string;
  category: string;
  project_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  event_type: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const COLUMNS = `id, sequence, severity, category, project_id, entity_type, entity_id,
                 event_type, message, metadata, created_at`;

function toEvent(row: Row): SystemEvent {
  return {
    id: row.id,
    sequence: row.sequence,
    severity: row.severity as SystemEventSeverity,
    category: row.category,
    projectId: row.project_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    eventType: row.event_type,
    message: row.message,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export interface SystemEventRepository {
  record(q: Queryable, event: NewSystemEvent): Promise<SystemEvent>;
  list(
    q: Queryable,
    filter: {
      severity?: SystemEventSeverity;
      category?: string;
      projectId?: string;
      cursorKey?: string;
      cursorId?: string;
      limit: number;
    },
  ): Promise<SystemEvent[]>;
  /** Replay for SSE reconnects: everything strictly after `sequence`, oldest first. */
  since(q: Queryable, sequence: number, limit: number): Promise<SystemEvent[]>;
  latestSequence(q: Queryable): Promise<number>;
  deleteBefore(q: Queryable, before: Date): Promise<number>;
}

export class PgSystemEventRepository implements SystemEventRepository {
  async record(q: Queryable, event: NewSystemEvent): Promise<SystemEvent> {
    const result = await q.query<Row>(
      `INSERT INTO shrine.system_events
         (severity, category, project_id, entity_type, entity_id, event_type, message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING ${COLUMNS}`,
      [
        event.severity,
        event.category,
        event.projectId ?? null,
        event.entityType ?? null,
        event.entityId ?? null,
        event.eventType,
        event.message,
        JSON.stringify(event.metadata ?? {}),
      ],
    );
    return toEvent(result.rows[0]!);
  }

  async list(
    q: Queryable,
    filter: {
      severity?: SystemEventSeverity;
      category?: string;
      projectId?: string;
      cursorKey?: string;
      cursorId?: string;
      limit: number;
    },
  ): Promise<SystemEvent[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.severity !== undefined) {
      values.push(filter.severity);
      conditions.push(`severity = $${values.length}`);
    }
    if (filter.category !== undefined) {
      values.push(filter.category);
      conditions.push(`category = $${values.length}`);
    }
    if (filter.projectId !== undefined) {
      values.push(filter.projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    if (filter.cursorKey !== undefined) {
      values.push(Number(filter.cursorKey));
      conditions.push(`sequence < $${values.length}`);
    }

    values.push(filter.limit);
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const result = await q.query<Row>(
      `SELECT ${COLUMNS} FROM shrine.system_events ${where}
        ORDER BY sequence DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(toEvent);
  }

  async since(q: Queryable, sequence: number, limit: number): Promise<SystemEvent[]> {
    const result = await q.query<Row>(
      `SELECT ${COLUMNS} FROM shrine.system_events
        WHERE sequence > $1 ORDER BY sequence ASC LIMIT $2`,
      [sequence, limit],
    );
    return result.rows.map(toEvent);
  }

  async latestSequence(q: Queryable): Promise<number> {
    const result = await q.query<{ sequence: number | null }>(
      `SELECT max(sequence) AS sequence FROM shrine.system_events`,
    );
    return result.rows[0]?.sequence ?? 0;
  }

  async deleteBefore(q: Queryable, before: Date): Promise<number> {
    const result = await q.query(`DELETE FROM shrine.system_events WHERE created_at < $1`, [before]);
    return result.rowCount ?? 0;
  }
}
