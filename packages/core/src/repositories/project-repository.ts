import type { Queryable } from '@saga/database';
import { isUniqueViolation } from '@saga/database';
import { SagaError } from '@saga/shared';
import type {
  LoreApprovalMode,
  Project,
  ProjectStatus,
  QuestCompletionMode,
} from '../domain/project.js';
import { normalizeProjectName } from '../normalization.js';

interface ProjectRow {
  id: string;
  name: string;
  name_key: string;
  description: string | null;
  status: string;
  memory_revision: number;
  active_context_snapshot_id: string | null;
  lore_approval_mode: string;
  quest_completion_mode: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, name, name_key, description, status, memory_revision,
                 active_context_snapshot_id, lore_approval_mode, quest_completion_mode,
                 created_at, updated_at`;

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    nameKey: row.name_key,
    description: row.description,
    status: row.status as ProjectStatus,
    memoryRevision: row.memory_revision,
    activeContextSnapshotId: row.active_context_snapshot_id,
    loreApprovalMode: row.lore_approval_mode as LoreApprovalMode,
    questCompletionMode: row.quest_completion_mode as QuestCompletionMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateProjectRow {
  name: string;
  nameKey: string;
  description: string | null;
  loreApprovalMode: LoreApprovalMode;
  questCompletionMode: QuestCompletionMode;
}

export interface ProjectRepository {
  create(q: Queryable, input: CreateProjectRow): Promise<Project>;
  findById(q: Queryable, id: string): Promise<Project | null>;
  findByNameKey(q: Queryable, nameKey: string): Promise<Project | null>;
  findByAliasKey(q: Queryable, aliasKey: string): Promise<Project | null>;
  lockById(q: Queryable, id: string): Promise<Project | null>;
  list(
    q: Queryable,
    filter: {
      status?: ProjectStatus;
      search?: string;
      cursorKey?: string;
      cursorId?: string;
      limit: number;
    },
  ): Promise<Project[]>;
  rename(q: Queryable, id: string, name: string, nameKey: string): Promise<Project>;
  update(
    q: Queryable,
    id: string,
    fields: {
      description?: string | null;
      loreApprovalMode?: LoreApprovalMode;
      questCompletionMode?: QuestCompletionMode;
    },
  ): Promise<Project>;
  setStatus(q: Queryable, id: string, status: ProjectStatus): Promise<Project>;
  addAlias(q: Queryable, projectId: string, alias: string, aliasKey: string): Promise<void>;
  listAliases(q: Queryable, projectId: string): Promise<string[]>;
  aliasesForProjects(q: Queryable, projectIds: readonly string[]): Promise<Map<string, string[]>>;
  /** Increments `memory_revision` by one and returns the new value. */
  bumpMemoryRevision(q: Queryable, id: string): Promise<number>;
  setActiveContextSnapshot(q: Queryable, id: string, snapshotId: string | null): Promise<void>;
  countByStatus(q: Queryable): Promise<{ total: number; active: number }>;
}

export class PgProjectRepository implements ProjectRepository {
  async create(q: Queryable, input: CreateProjectRow): Promise<Project> {
    try {
      const result = await q.query<ProjectRow>(
        `INSERT INTO core.projects
           (name, name_key, description, lore_approval_mode, quest_completion_mode)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [
          input.name,
          input.nameKey,
          input.description,
          input.loreApprovalMode,
          input.questCompletionMode,
        ],
      );
      return toProject(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error, 'projects_name_key_uniq')) {
        throw new SagaError(
          'PROJECT_NAME_CONFLICT',
          `A project named "${input.name}" already exists.`,
          {
            details: { name: input.name, name_key: input.nameKey },
          },
        );
      }
      throw error;
    }
  }

  async findById(q: Queryable, id: string): Promise<Project | null> {
    const result = await q.query<ProjectRow>(`SELECT ${COLUMNS} FROM core.projects WHERE id = $1`, [
      id,
    ]);
    return result.rows[0] === undefined ? null : toProject(result.rows[0]);
  }

  async findByNameKey(q: Queryable, nameKey: string): Promise<Project | null> {
    const result = await q.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM core.projects WHERE name_key = $1`,
      [nameKey],
    );
    return result.rows[0] === undefined ? null : toProject(result.rows[0]);
  }

  async findByAliasKey(q: Queryable, aliasKey: string): Promise<Project | null> {
    const result = await q.query<ProjectRow>(
      `SELECT ${COLUMNS.split(',')
        .map((column) => `p.${column.trim()}`)
        .join(', ')}
         FROM core.project_aliases a
         JOIN core.projects p ON p.id = a.project_id
        WHERE a.alias_key = $1`,
      [aliasKey],
    );
    return result.rows[0] === undefined ? null : toProject(result.rows[0]);
  }

  async lockById(q: Queryable, id: string): Promise<Project | null> {
    const result = await q.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM core.projects WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] === undefined ? null : toProject(result.rows[0]);
  }

  async list(
    q: Queryable,
    filter: {
      status?: ProjectStatus;
      search?: string;
      cursorKey?: string;
      cursorId?: string;
      limit: number;
    },
  ): Promise<Project[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.status !== undefined) {
      values.push(filter.status);
      conditions.push(`status = $${values.length}`);
    }
    if (filter.search !== undefined && filter.search.trim().length > 0) {
      values.push(`%${normalizeProjectName(filter.search)}%`);
      conditions.push(`name_key LIKE $${values.length}`);
    }
    // Keyset pagination on (name_key, id): stable, and unaffected by concurrent updates.
    if (filter.cursorKey !== undefined && filter.cursorId !== undefined) {
      values.push(filter.cursorKey, filter.cursorId);
      conditions.push(`(name_key, id) > ($${values.length - 1}, $${values.length})`);
    }

    values.push(filter.limit);
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const result = await q.query<ProjectRow>(
      `SELECT ${COLUMNS} FROM core.projects ${where} ORDER BY name_key, id LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(toProject);
  }

  async rename(q: Queryable, id: string, name: string, nameKey: string): Promise<Project> {
    try {
      const result = await q.query<ProjectRow>(
        `UPDATE core.projects
            SET name = $2, name_key = $3, updated_at = now()
          WHERE id = $1
        RETURNING ${COLUMNS}`,
        [id, name, nameKey],
      );
      if (result.rows[0] === undefined) {
        throw new SagaError('PROJECT_NOT_FOUND', 'The project no longer exists.');
      }
      return toProject(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error, 'projects_name_key_uniq')) {
        throw new SagaError('PROJECT_NAME_CONFLICT', `A project named "${name}" already exists.`, {
          details: { name, name_key: nameKey },
        });
      }
      throw error;
    }
  }

  async update(
    q: Queryable,
    id: string,
    fields: {
      description?: string | null;
      loreApprovalMode?: LoreApprovalMode;
      questCompletionMode?: QuestCompletionMode;
    },
  ): Promise<Project> {
    const assignments: string[] = [];
    const values: unknown[] = [id];

    if (fields.description !== undefined) {
      values.push(fields.description);
      assignments.push(`description = $${values.length}`);
    }
    if (fields.loreApprovalMode !== undefined) {
      values.push(fields.loreApprovalMode);
      assignments.push(`lore_approval_mode = $${values.length}`);
    }
    if (fields.questCompletionMode !== undefined) {
      values.push(fields.questCompletionMode);
      assignments.push(`quest_completion_mode = $${values.length}`);
    }
    if (assignments.length === 0) {
      const existing = await this.findById(q, id);
      if (existing === null)
        throw new SagaError('PROJECT_NOT_FOUND', 'The project no longer exists.');
      return existing;
    }

    const result = await q.query<ProjectRow>(
      `UPDATE core.projects SET ${assignments.join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      values,
    );
    if (result.rows[0] === undefined) {
      throw new SagaError('PROJECT_NOT_FOUND', 'The project no longer exists.');
    }
    return toProject(result.rows[0]);
  }

  async setStatus(q: Queryable, id: string, status: ProjectStatus): Promise<Project> {
    const result = await q.query<ProjectRow>(
      `UPDATE core.projects SET status = $2, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, status],
    );
    if (result.rows[0] === undefined) {
      throw new SagaError('PROJECT_NOT_FOUND', 'The project no longer exists.');
    }
    return toProject(result.rows[0]);
  }

  async addAlias(q: Queryable, projectId: string, alias: string, aliasKey: string): Promise<void> {
    try {
      await q.query(
        `INSERT INTO core.project_aliases (project_id, alias, alias_key) VALUES ($1, $2, $3)`,
        [projectId, alias, aliasKey],
      );
    } catch (error) {
      if (isUniqueViolation(error, 'project_aliases_alias_key_uniq')) {
        throw new SagaError('PROJECT_NAME_CONFLICT', `The alias "${alias}" is already in use.`, {
          details: { alias, alias_key: aliasKey },
        });
      }
      throw error;
    }
  }

  async listAliases(q: Queryable, projectId: string): Promise<string[]> {
    const result = await q.query<{ alias: string }>(
      `SELECT alias FROM core.project_aliases WHERE project_id = $1 ORDER BY created_at, alias`,
      [projectId],
    );
    return result.rows.map((row) => row.alias);
  }

  async aliasesForProjects(
    q: Queryable,
    projectIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (projectIds.length === 0) return map;
    const result = await q.query<{ project_id: string; alias: string }>(
      `SELECT project_id, alias FROM core.project_aliases
        WHERE project_id = ANY($1::uuid[]) ORDER BY created_at, alias`,
      [projectIds],
    );
    for (const row of result.rows) {
      const list = map.get(row.project_id) ?? [];
      list.push(row.alias);
      map.set(row.project_id, list);
    }
    return map;
  }

  async bumpMemoryRevision(q: Queryable, id: string): Promise<number> {
    const result = await q.query<{ memory_revision: number }>(
      `UPDATE core.projects SET memory_revision = memory_revision + 1, updated_at = now()
        WHERE id = $1 RETURNING memory_revision`,
      [id],
    );
    if (result.rows[0] === undefined) {
      throw new SagaError('PROJECT_NOT_FOUND', 'The project no longer exists.');
    }
    return result.rows[0].memory_revision;
  }

  async setActiveContextSnapshot(
    q: Queryable,
    id: string,
    snapshotId: string | null,
  ): Promise<void> {
    await q.query(
      `UPDATE core.projects SET active_context_snapshot_id = $2, updated_at = now() WHERE id = $1`,
      [id, snapshotId],
    );
  }

  async countByStatus(q: Queryable): Promise<{ total: number; active: number }> {
    const result = await q.query<{ total: string; active: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE status = 'active')::text AS active
         FROM core.projects`,
    );
    const row = result.rows[0]!;
    return { total: Number(row.total), active: Number(row.active) };
  }
}
