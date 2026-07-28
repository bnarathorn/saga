import type {
  ActivationMode,
  CheckpointKind,
  DependencyType,
  QuestPriority,
  QuestScope,
  QuestStatus,
  SessionState,
  WorkState,
} from '@saga/contracts';
import type { Queryable } from '@saga/database';
import { isUniqueViolation, toVectorLiteral } from '@saga/database';
import { SagaError } from '@saga/shared';

// ---------------------------------------------------------------------------
// domain shapes
// ---------------------------------------------------------------------------

export interface Quest {
  id: string;
  projectId: string;
  parentWorkItemId: string | null;
  title: string;
  objective: string | null;
  status: QuestStatus;
  priority: QuestPriority;
  scope: QuestScope;
  revision: number;
  latestCheckpointId: string | null;
  createdBySessionId: string | null;
  statusSetManually: boolean;
  embeddingState: 'queued' | 'claimed' | 'ready' | 'failed';
  createdAt: Date;
  lastActivityAt: Date;
  completedAt: Date | null;
  archivedAt: Date | null;
}

export interface QuestSession {
  id: string;
  projectId: string;
  workItemId: string | null;
  client: string;
  agent: string | null;
  state: SessionState;
  activationMode: ActivationMode | null;
  initialTask: string | null;
  startedMemoryRevision: number;
  workspaceKey: string | null;
  workspaceLabel: string | null;
  startedAt: Date;
  activatedAt: Date | null;
  lastSeenAt: Date | null;
  endedAt: Date | null;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  workItemId: string;
  baseWorkItemRevision: number;
  sequence: number;
  kind: CheckpointKind;
  summary: string;
  workState: WorkState;
  createdAt: Date;
}

export interface QuestDependency {
  workItemId: string;
  dependsOnWorkItemId: string;
  dependsOnTitle: string;
  dependsOnStatus: QuestStatus;
  dependencyType: DependencyType;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// row mapping
// ---------------------------------------------------------------------------

interface QuestRow {
  id: string;
  project_id: string;
  parent_work_item_id: string | null;
  title: string;
  objective: string | null;
  status: string;
  priority: string;
  scope: QuestScope;
  revision: number;
  latest_checkpoint_id: string | null;
  created_by_session_id: string | null;
  status_set_manually: boolean;
  embedding_state: string;
  created_at: Date;
  last_activity_at: Date;
  completed_at: Date | null;
  archived_at: Date | null;
}

const QUEST_COLUMNS = `id, project_id, parent_work_item_id, title, objective, status, priority,
                       scope, revision, latest_checkpoint_id, created_by_session_id,
                       status_set_manually, embedding_state, created_at, last_activity_at,
                       completed_at, archived_at`;

function toQuest(row: QuestRow): Quest {
  return {
    id: row.id,
    projectId: row.project_id,
    parentWorkItemId: row.parent_work_item_id,
    title: row.title,
    objective: row.objective,
    status: row.status as QuestStatus,
    priority: row.priority as QuestPriority,
    scope: row.scope,
    revision: row.revision,
    latestCheckpointId: row.latest_checkpoint_id,
    createdBySessionId: row.created_by_session_id,
    statusSetManually: row.status_set_manually,
    embeddingState: row.embedding_state as Quest['embeddingState'],
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
  };
}

interface SessionRow {
  id: string;
  project_id: string;
  work_item_id: string | null;
  client: string;
  agent: string | null;
  state: string;
  activation_mode: string | null;
  initial_task: string | null;
  started_memory_revision: number;
  workspace_key: string | null;
  workspace_label: string | null;
  started_at: Date;
  activated_at: Date | null;
  last_seen_at: Date | null;
  ended_at: Date | null;
}

const SESSION_COLUMNS = `id, project_id, work_item_id, client, agent, state, activation_mode,
                         initial_task, started_memory_revision, workspace_key, workspace_label,
                         started_at, activated_at, last_seen_at, ended_at`;

function toSession(row: SessionRow): QuestSession {
  return {
    id: row.id,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    client: row.client,
    agent: row.agent,
    state: row.state as SessionState,
    activationMode: row.activation_mode as ActivationMode | null,
    initialTask: row.initial_task,
    startedMemoryRevision: row.started_memory_revision,
    workspaceKey: row.workspace_key,
    workspaceLabel: row.workspace_label,
    startedAt: row.started_at,
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at,
  };
}

interface CheckpointRow {
  id: string;
  session_id: string;
  work_item_id: string;
  base_work_item_revision: number;
  sequence: number;
  kind: string;
  summary: string;
  work_state: WorkState;
  created_at: Date;
}

const CHECKPOINT_COLUMNS = `id, session_id, work_item_id, base_work_item_revision, sequence,
                            kind, summary, work_state, created_at`;

function toCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    workItemId: row.work_item_id,
    baseWorkItemRevision: row.base_work_item_revision,
    sequence: row.sequence,
    kind: row.kind as CheckpointKind,
    summary: row.summary,
    workState: row.work_state,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------

export class QuestRepository {
  // --- quests --------------------------------------------------------------

  async create(
    tx: Queryable,
    input: {
      projectId: string;
      title: string;
      objective: string | null;
      priority: QuestPriority;
      scope: QuestScope;
      parentWorkItemId: string | null;
      createdBySessionId: string | null;
      searchText: string;
    },
  ): Promise<Quest> {
    const result = await tx.query<QuestRow>(
      `INSERT INTO quest.work_items
         (project_id, title, objective, priority, scope, parent_work_item_id,
          created_by_session_id, search_document)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, to_tsvector('english', $8))
       RETURNING ${QUEST_COLUMNS}`,
      [
        input.projectId,
        input.title,
        input.objective,
        input.priority,
        JSON.stringify(input.scope),
        input.parentWorkItemId,
        input.createdBySessionId,
        input.searchText,
      ],
    );
    return toQuest(result.rows[0]!);
  }

  async findById(q: Queryable, id: string): Promise<Quest | null> {
    const result = await q.query<QuestRow>(
      `SELECT ${QUEST_COLUMNS} FROM quest.work_items WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toQuest(result.rows[0]);
  }

  async lockById(tx: Queryable, id: string): Promise<Quest | null> {
    const result = await tx.query<QuestRow>(
      `SELECT ${QUEST_COLUMNS} FROM quest.work_items WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] === undefined ? null : toQuest(result.rows[0]);
  }

  async list(
    q: Queryable,
    filter: {
      projectId: string;
      status?: QuestStatus;
      priority?: QuestPriority;
      parentWorkItemId?: string;
      includeArchived?: boolean;
      search?: string;
      cursorKey?: string;
      cursorId?: string;
      limit: number;
    },
  ): Promise<Quest[]> {
    const conditions = ['project_id = $1'];
    const values: unknown[] = [filter.projectId];
    const push = (fragment: (index: number) => string, value: unknown) => {
      values.push(value);
      conditions.push(fragment(values.length));
    };

    if (filter.status !== undefined) push((i) => `status = $${i}`, filter.status);
    if (filter.priority !== undefined) push((i) => `priority = $${i}`, filter.priority);
    if (filter.parentWorkItemId !== undefined) {
      push((i) => `parent_work_item_id = $${i}`, filter.parentWorkItemId);
    }
    if (filter.includeArchived !== true) conditions.push('archived_at IS NULL');
    if (filter.search !== undefined && filter.search.trim().length > 0) {
      push((i) => `(title ILIKE $${i} OR objective ILIKE $${i})`, `%${filter.search.trim()}%`);
    }
    if (filter.cursorKey !== undefined && filter.cursorId !== undefined) {
      values.push(filter.cursorKey, filter.cursorId);
      conditions.push(
        `(last_activity_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`,
      );
    }

    values.push(filter.limit);
    const result = await q.query<QuestRow>(
      `SELECT ${QUEST_COLUMNS} FROM quest.work_items
        WHERE ${conditions.join(' AND ')}
        ORDER BY last_activity_at DESC, id DESC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(toQuest);
  }

  /** Open Quests offered as resume candidates at activation time. */
  async listResumable(q: Queryable, projectId: string, limit: number): Promise<Quest[]> {
    const result = await q.query<QuestRow>(
      `SELECT ${QUEST_COLUMNS} FROM quest.work_items
        WHERE project_id = $1
          AND status NOT IN ('completed', 'cancelled')
          AND archived_at IS NULL
        ORDER BY last_activity_at DESC
        LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(toQuest);
  }

  async listChildren(q: Queryable, parentId: string): Promise<Quest[]> {
    const result = await q.query<QuestRow>(
      `SELECT ${QUEST_COLUMNS} FROM quest.work_items
        WHERE parent_work_item_id = $1 ORDER BY created_at`,
      [parentId],
    );
    return result.rows.map(toQuest);
  }

  /** Every parent edge in the project, for cycle detection. */
  async parentEdges(q: Queryable, projectId: string): Promise<{ from: string; to: string }[]> {
    const result = await q.query<{ id: string; parent_work_item_id: string }>(
      `SELECT id, parent_work_item_id FROM quest.work_items
        WHERE project_id = $1 AND parent_work_item_id IS NOT NULL`,
      [projectId],
    );
    return result.rows.map((row) => ({ from: row.id, to: row.parent_work_item_id }));
  }

  async update(
    tx: Queryable,
    id: string,
    fields: {
      title?: string;
      objective?: string | null;
      status?: QuestStatus;
      priority?: QuestPriority;
      scope?: QuestScope;
      parentWorkItemId?: string | null;
      statusSetManually?: boolean;
      searchText?: string;
    },
  ): Promise<Quest> {
    const assignments: string[] = [];
    const values: unknown[] = [id];
    const push = (fragment: (index: number) => string, value: unknown) => {
      values.push(value);
      assignments.push(fragment(values.length));
    };

    if (fields.title !== undefined) push((i) => `title = $${i}`, fields.title);
    if (fields.objective !== undefined) push((i) => `objective = $${i}`, fields.objective);
    if (fields.priority !== undefined) push((i) => `priority = $${i}`, fields.priority);
    if (fields.scope !== undefined)
      push((i) => `scope = $${i}::jsonb`, JSON.stringify(fields.scope));
    if (fields.parentWorkItemId !== undefined) {
      push((i) => `parent_work_item_id = $${i}`, fields.parentWorkItemId);
    }
    if (fields.statusSetManually !== undefined) {
      push((i) => `status_set_manually = $${i}`, fields.statusSetManually);
    }
    if (fields.searchText !== undefined) {
      push((i) => `search_document = to_tsvector('english', $${i})`, fields.searchText);
      // The title changed, so the stored embedding no longer describes the Quest.
      assignments.push(`embedding_state = 'queued'`);
    }
    if (fields.status !== undefined) {
      push((i) => `status = $${i}`, fields.status);
      assignments.push(
        `completed_at = CASE WHEN $${values.length} = 'completed' THEN now() ELSE NULL END`,
      );
    }

    if (assignments.length === 0) {
      const existing = await this.findById(tx, id);
      if (existing === null) throw new SagaError('QUEST_NOT_FOUND', 'The Quest no longer exists.');
      return existing;
    }

    const result = await tx.query<QuestRow>(
      `UPDATE quest.work_items SET ${assignments.join(', ')}, last_activity_at = now()
        WHERE id = $1 RETURNING ${QUEST_COLUMNS}`,
      values,
    );
    if (result.rows[0] === undefined) {
      throw new SagaError('QUEST_NOT_FOUND', 'The Quest no longer exists.');
    }
    return toQuest(result.rows[0]);
  }

  async setArchived(tx: Queryable, id: string, archived: boolean): Promise<Quest> {
    const result = await tx.query<QuestRow>(
      `UPDATE quest.work_items SET archived_at = ${archived ? 'now()' : 'NULL'}, last_activity_at = now()
        WHERE id = $1 RETURNING ${QUEST_COLUMNS}`,
      [id],
    );
    if (result.rows[0] === undefined) {
      throw new SagaError('QUEST_NOT_FOUND', 'The Quest no longer exists.');
    }
    return toQuest(result.rows[0]);
  }

  /** Worker-owned write: the embedding fields are the only part of a Quest the worker sets. */
  async setEmbedding(q: Queryable, id: string, embedding: readonly number[]): Promise<boolean> {
    const result = await q.query(
      `UPDATE quest.work_items SET embedding = $2::vector, embedding_state = 'ready' WHERE id = $1`,
      [id, toVectorLiteral(embedding)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async setEmbeddingState(
    q: Queryable,
    id: string,
    state: 'queued' | 'claimed' | 'ready' | 'failed',
  ): Promise<void> {
    await q.query(`UPDATE quest.work_items SET embedding_state = $2 WHERE id = $1`, [id, state]);
  }

  async touch(tx: Queryable, id: string): Promise<void> {
    await tx.query(`UPDATE quest.work_items SET last_activity_at = now() WHERE id = $1`, [id]);
  }

  async counts(
    q: Queryable,
    projectIds: readonly string[],
  ): Promise<Map<string, { open: number; blocked: number; lastActivityAt: Date | null }>> {
    const map = new Map<string, { open: number; blocked: number; lastActivityAt: Date | null }>();
    if (projectIds.length === 0) return map;
    const result = await q.query<{
      project_id: string;
      open: string;
      blocked: string;
      last_activity_at: Date | null;
    }>(
      `SELECT project_id,
              count(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND archived_at IS NULL)::text AS open,
              count(*) FILTER (WHERE status = 'blocked' AND archived_at IS NULL)::text AS blocked,
              max(last_activity_at) AS last_activity_at
         FROM quest.work_items
        WHERE project_id = ANY($1::uuid[])
        GROUP BY project_id`,
      [[...projectIds]],
    );
    for (const row of result.rows) {
      map.set(row.project_id, {
        open: Number(row.open),
        blocked: Number(row.blocked),
        lastActivityAt: row.last_activity_at,
      });
    }
    return map;
  }

  async totals(q: Queryable): Promise<{ open: number; blocked: number }> {
    const result = await q.query<{ open: string; blocked: string }>(
      `SELECT count(*) FILTER (WHERE status NOT IN ('completed','cancelled') AND archived_at IS NULL)::text AS open,
              count(*) FILTER (WHERE status = 'blocked' AND archived_at IS NULL)::text AS blocked
         FROM quest.work_items`,
    );
    const row = result.rows[0]!;
    return { open: Number(row.open), blocked: Number(row.blocked) };
  }

  // --- dependencies --------------------------------------------------------

  async addDependency(
    tx: Queryable,
    input: { workItemId: string; dependsOnWorkItemId: string; dependencyType: DependencyType },
  ): Promise<void> {
    try {
      await tx.query(
        `INSERT INTO quest.work_item_dependencies
           (work_item_id, depends_on_work_item_id, dependency_type)
         VALUES ($1, $2, $3)`,
        [input.workItemId, input.dependsOnWorkItemId, input.dependencyType],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new SagaError('CONFLICT', 'That dependency already exists.');
      }
      throw error;
    }
  }

  async removeDependency(tx: Queryable, workItemId: string, dependsOnId: string): Promise<boolean> {
    const result = await tx.query(
      `DELETE FROM quest.work_item_dependencies
        WHERE work_item_id = $1 AND depends_on_work_item_id = $2`,
      [workItemId, dependsOnId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async listDependencies(q: Queryable, workItemId: string): Promise<QuestDependency[]> {
    const result = await q.query<{
      work_item_id: string;
      depends_on_work_item_id: string;
      depends_on_title: string;
      depends_on_status: string;
      dependency_type: string;
      created_at: Date;
    }>(
      `SELECT d.work_item_id, d.depends_on_work_item_id, w.title AS depends_on_title,
              w.status AS depends_on_status, d.dependency_type, d.created_at
         FROM quest.work_item_dependencies d
         JOIN quest.work_items w ON w.id = d.depends_on_work_item_id
        WHERE d.work_item_id = $1
        ORDER BY d.created_at`,
      [workItemId],
    );
    return result.rows.map((row) => ({
      workItemId: row.work_item_id,
      dependsOnWorkItemId: row.depends_on_work_item_id,
      dependsOnTitle: row.depends_on_title,
      dependsOnStatus: row.depends_on_status as QuestStatus,
      dependencyType: row.dependency_type as DependencyType,
      createdAt: row.created_at,
    }));
  }

  async dependencyEdges(q: Queryable, projectId: string): Promise<{ from: string; to: string }[]> {
    const result = await q.query<{ work_item_id: string; depends_on_work_item_id: string }>(
      `SELECT d.work_item_id, d.depends_on_work_item_id
         FROM quest.work_item_dependencies d
         JOIN quest.work_items w ON w.id = d.work_item_id
        WHERE w.project_id = $1`,
      [projectId],
    );
    return result.rows.map((row) => ({
      from: row.work_item_id,
      to: row.depends_on_work_item_id,
    }));
  }

  // --- sessions ------------------------------------------------------------

  async createSession(
    tx: Queryable,
    input: {
      projectId: string;
      client: string;
      agent: string | null;
      startedMemoryRevision: number;
      workspaceKey: string | null;
      workspaceLabel: string | null;
    },
  ): Promise<QuestSession> {
    const result = await tx.query<SessionRow>(
      `INSERT INTO quest.sessions
         (project_id, client, agent, started_memory_revision, workspace_key, workspace_label,
          last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       RETURNING ${SESSION_COLUMNS}`,
      [
        input.projectId,
        input.client,
        input.agent,
        input.startedMemoryRevision,
        input.workspaceKey,
        input.workspaceLabel,
      ],
    );
    return toSession(result.rows[0]!);
  }

  async findSessionById(q: Queryable, id: string): Promise<QuestSession | null> {
    const result = await q.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM quest.sessions WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toSession(result.rows[0]);
  }

  async lockSessionById(tx: Queryable, id: string): Promise<QuestSession | null> {
    const result = await tx.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM quest.sessions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] === undefined ? null : toSession(result.rows[0]);
  }

  async activateSession(
    tx: Queryable,
    id: string,
    input: { workItemId: string | null; activationMode: ActivationMode; initialTask: string },
  ): Promise<QuestSession> {
    const result = await tx.query<SessionRow>(
      `UPDATE quest.sessions
          SET state = 'active', work_item_id = $2, activation_mode = $3, initial_task = $4,
              activated_at = COALESCE(activated_at, now()), last_seen_at = now()
        WHERE id = $1
       RETURNING ${SESSION_COLUMNS}`,
      [id, input.workItemId, input.activationMode, input.initialTask],
    );
    if (result.rows[0] === undefined) {
      throw new SagaError('SESSION_NOT_FOUND', 'The session no longer exists.');
    }
    return toSession(result.rows[0]);
  }

  async attachSessionToQuest(tx: Queryable, id: string, workItemId: string): Promise<QuestSession> {
    const result = await tx.query<SessionRow>(
      `UPDATE quest.sessions SET work_item_id = $2, last_seen_at = now()
        WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
      [id, workItemId],
    );
    if (result.rows[0] === undefined) {
      throw new SagaError('SESSION_NOT_FOUND', 'The session no longer exists.');
    }
    return toSession(result.rows[0]);
  }

  async endSession(
    tx: Queryable,
    id: string,
    state: 'completed' | 'abandoned',
  ): Promise<QuestSession> {
    const result = await tx.query<SessionRow>(
      `UPDATE quest.sessions SET state = $2, ended_at = now(), last_seen_at = now()
        WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
      [id, state],
    );
    if (result.rows[0] === undefined) {
      throw new SagaError('SESSION_NOT_FOUND', 'The session no longer exists.');
    }
    return toSession(result.rows[0]);
  }

  async touchSession(q: Queryable, id: string): Promise<void> {
    await q.query(`UPDATE quest.sessions SET last_seen_at = now() WHERE id = $1`, [id]);
  }

  async listSessionsForQuest(q: Queryable, workItemId: string): Promise<QuestSession[]> {
    const result = await q.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM quest.sessions
        WHERE work_item_id = $1 ORDER BY started_at DESC`,
      [workItemId],
    );
    return result.rows.map(toSession);
  }

  /** Sessions that stopped reporting and should be marked abandoned. */
  async findStaleSessions(q: Queryable, olderThan: Date, limit: number): Promise<QuestSession[]> {
    const result = await q.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM quest.sessions
        WHERE state IN ('awaiting_task', 'active')
          AND COALESCE(last_seen_at, started_at) < $1
        ORDER BY COALESCE(last_seen_at, started_at)
        LIMIT $2`,
      [olderThan, limit],
    );
    return result.rows.map(toSession);
  }

  // --- checkpoints ---------------------------------------------------------

  /**
   * Insert a checkpoint and advance the Quest revision in one statement pair.
   *
   * The caller must already hold the Quest row lock and have verified the expected revision;
   * `nextSequence` is derived inside the same transaction so two sessions cannot collide.
   */
  async insertCheckpoint(
    tx: Queryable,
    input: {
      sessionId: string;
      workItemId: string;
      baseWorkItemRevision: number;
      kind: CheckpointKind;
      summary: string;
      workState: WorkState;
    },
  ): Promise<Checkpoint> {
    const sequence = await tx.query<{ next: number }>(
      `SELECT COALESCE(max(sequence), 0) + 1 AS next FROM quest.checkpoints WHERE session_id = $1`,
      [input.sessionId],
    );

    const result = await tx.query<CheckpointRow>(
      `INSERT INTO quest.checkpoints
         (session_id, work_item_id, base_work_item_revision, sequence, kind, summary, work_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING ${CHECKPOINT_COLUMNS}`,
      [
        input.sessionId,
        input.workItemId,
        input.baseWorkItemRevision,
        sequence.rows[0]!.next,
        input.kind,
        input.summary,
        JSON.stringify(input.workState),
      ],
    );
    return toCheckpoint(result.rows[0]!);
  }

  /**
   * Compare-and-swap the Quest revision. Returns null when the expected revision is stale,
   * which the service turns into a 409 rather than overwriting the latest checkpoint.
   */
  async advanceRevision(
    tx: Queryable,
    workItemId: string,
    expectedRevision: number,
    checkpointId: string,
  ): Promise<Quest | null> {
    const result = await tx.query<QuestRow>(
      `UPDATE quest.work_items
          SET revision = revision + 1,
              latest_checkpoint_id = $3,
              last_activity_at = now()
        WHERE id = $1 AND revision = $2
       RETURNING ${QUEST_COLUMNS}`,
      [workItemId, expectedRevision, checkpointId],
    );
    return result.rows[0] === undefined ? null : toQuest(result.rows[0]);
  }

  async listCheckpoints(q: Queryable, workItemId: string, limit: number): Promise<Checkpoint[]> {
    const result = await q.query<CheckpointRow>(
      `SELECT ${CHECKPOINT_COLUMNS} FROM quest.checkpoints
        WHERE work_item_id = $1 ORDER BY created_at DESC, sequence DESC LIMIT $2`,
      [workItemId, limit],
    );
    return result.rows.map(toCheckpoint);
  }

  async findCheckpointById(q: Queryable, id: string): Promise<Checkpoint | null> {
    const result = await q.query<CheckpointRow>(
      `SELECT ${CHECKPOINT_COLUMNS} FROM quest.checkpoints WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toCheckpoint(result.rows[0]);
  }

  /**
   * The best continuation record for a Quest: the most recent final handoff, or — when a
   * session was interrupted before one was written — its most recent checkpoint.
   */
  async findContinuation(
    q: Queryable,
    workItemId: string,
  ): Promise<{ checkpoint: Checkpoint; recovered: boolean } | null> {
    const handoff = await q.query<CheckpointRow>(
      `SELECT ${CHECKPOINT_COLUMNS} FROM quest.checkpoints
        WHERE work_item_id = $1 AND kind = 'final_handoff'
        ORDER BY created_at DESC LIMIT 1`,
      [workItemId],
    );

    const latest = await q.query<CheckpointRow>(
      `SELECT ${CHECKPOINT_COLUMNS} FROM quest.checkpoints
        WHERE work_item_id = $1 ORDER BY created_at DESC, sequence DESC LIMIT 1`,
      [workItemId],
    );

    if (latest.rows[0] === undefined) return null;
    const latestCheckpoint = toCheckpoint(latest.rows[0]);

    if (handoff.rows[0] === undefined) {
      return { checkpoint: latestCheckpoint, recovered: true };
    }
    const handoffCheckpoint = toCheckpoint(handoff.rows[0]);

    // Work continued after the handoff was written: prefer the newer record and say so.
    if (latestCheckpoint.createdAt > handoffCheckpoint.createdAt) {
      return { checkpoint: latestCheckpoint, recovered: true };
    }
    return { checkpoint: handoffCheckpoint, recovered: false };
  }
}
