import type { SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import { SagaError, buildPage, decodeCursor, type Page } from '@saga/shared';
import { isUuid } from '@saga/shared/ids';
import type { LoreApprovalMode, Project, ProjectStatus, ProjectWithAliases } from '../domain/project.js';
import { assertValidProjectName, normalizeProjectName } from '../normalization.js';
import type { OutboxRepository } from '../repositories/outbox-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';

export interface ProjectServiceDeps {
  pool: SagaPool;
  projects: ProjectRepository;
  outbox: OutboxRepository;
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  loreApprovalMode?: LoreApprovalMode;
  correlationId?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  loreApprovalMode?: LoreApprovalMode;
  correlationId?: string;
}

export interface ListProjectsInput {
  status?: ProjectStatus;
  search?: string;
  cursor?: string;
  limit: number;
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  /**
   * Resolve a `projectRef` from any of: UUID, current name, normalized current name, or a
   * former alias. Resolution never consults version-control information.
   */
  async resolve(ref: string): Promise<Project> {
    const project = await this.tryResolve(ref);
    if (project === null) {
      throw new SagaError('PROJECT_NOT_FOUND', `No project matches "${ref}".`, {
        details: { project_ref: ref },
      });
    }
    return project;
  }

  async tryResolve(ref: string): Promise<Project | null> {
    const trimmed = ref.trim();
    if (trimmed.length === 0) return null;

    if (isUuid(trimmed)) {
      const byId = await this.deps.projects.findById(this.deps.pool, trimmed);
      if (byId !== null) return byId;
    }

    const key = normalizeProjectName(trimmed);
    if (key.length === 0) return null;

    const byName = await this.deps.projects.findByNameKey(this.deps.pool, key);
    if (byName !== null) return byName;

    return this.deps.projects.findByAliasKey(this.deps.pool, key);
  }

  async withAliases(project: Project): Promise<ProjectWithAliases> {
    const aliases = await this.deps.projects.listAliases(this.deps.pool, project.id);
    return { ...project, aliases };
  }

  async create(input: CreateProjectInput): Promise<ProjectWithAliases> {
    const name = assertValidProjectName(input.name);
    const nameKey = normalizeProjectName(name);

    return withTransaction(this.deps.pool, async (tx) => {
      // A new name must not collide with an existing project name *or* an existing alias,
      // otherwise `projectRef` resolution would become ambiguous.
      const aliasOwner = await this.deps.projects.findByAliasKey(tx, nameKey);
      if (aliasOwner !== null) {
        throw new SagaError(
          'PROJECT_NAME_CONFLICT',
          `"${name}" is already a former name of the project "${aliasOwner.name}".`,
          { details: { name, conflicting_project_id: aliasOwner.id } },
        );
      }

      const project = await this.deps.projects.create(tx, {
        name,
        nameKey,
        description: input.description ?? null,
        loreApprovalMode: input.loreApprovalMode ?? 'auto',
      });

      await this.deps.outbox.emit(tx, {
        aggregateType: 'project',
        aggregateId: project.id,
        topic: 'core.project_created',
        payload: { project_id: project.id, name: project.name },
        correlationId: input.correlationId ?? null,
        projectId: project.id,
      });

      return { ...project, aliases: [] };
    });
  }

  /**
   * Rename preserves the UUID and records the previous name as an alias in the same
   * transaction, so an old reference keeps resolving.
   */
  async update(ref: string, input: UpdateProjectInput): Promise<ProjectWithAliases> {
    const current = await this.resolve(ref);

    return withTransaction(this.deps.pool, async (tx) => {
      const locked = await this.deps.projects.lockById(tx, current.id);
      if (locked === null) {
        throw new SagaError('PROJECT_NOT_FOUND', `No project matches "${ref}".`);
      }
      if (locked.status === 'archived') {
        throw new SagaError(
          'PROJECT_ARCHIVED',
          `The project "${locked.name}" is archived and is read-only. Restore it first.`,
          { details: { project_id: locked.id } },
        );
      }

      let project = locked;

      if (input.name !== undefined) {
        const name = assertValidProjectName(input.name);
        const nameKey = normalizeProjectName(name);

        if (nameKey !== locked.nameKey) {
          const nameOwner = await this.deps.projects.findByNameKey(tx, nameKey);
          if (nameOwner !== null && nameOwner.id !== locked.id) {
            throw new SagaError('PROJECT_NAME_CONFLICT', `A project named "${name}" already exists.`, {
              details: { name },
            });
          }
          const aliasOwner = await this.deps.projects.findByAliasKey(tx, nameKey);
          if (aliasOwner !== null && aliasOwner.id !== locked.id) {
            throw new SagaError(
              'PROJECT_NAME_CONFLICT',
              `"${name}" is already a former name of the project "${aliasOwner.name}".`,
              { details: { name, conflicting_project_id: aliasOwner.id } },
            );
          }

          project = await this.deps.projects.rename(tx, locked.id, name, nameKey);

          // Reclaiming one of this project's own former names is fine; the alias row already
          // points here, so only genuinely new previous names need inserting.
          const existingAliases = await this.deps.projects.listAliases(tx, locked.id);
          const existingKeys = new Set(existingAliases.map(normalizeProjectName));
          if (!existingKeys.has(locked.nameKey)) {
            await this.deps.projects.addAlias(tx, locked.id, locked.name, locked.nameKey);
          }

          await this.deps.outbox.emit(tx, {
            aggregateType: 'project',
            aggregateId: locked.id,
            topic: 'core.project_renamed',
            payload: { project_id: locked.id, from: locked.name, to: name },
            correlationId: input.correlationId ?? null,
            projectId: locked.id,
          });
        }
      }

      if (input.description !== undefined || input.loreApprovalMode !== undefined) {
        const fields: { description?: string | null; loreApprovalMode?: LoreApprovalMode } = {};
        if (input.description !== undefined) fields.description = input.description;
        if (input.loreApprovalMode !== undefined) fields.loreApprovalMode = input.loreApprovalMode;
        project = await this.deps.projects.update(tx, locked.id, fields);
      }

      const aliases = await this.deps.projects.listAliases(tx, project.id);
      return { ...project, aliases };
    });
  }

  async archive(ref: string, reason: string, correlationId?: string): Promise<ProjectWithAliases> {
    return this.setStatus(ref, 'archived', 'core.project_archived', reason, correlationId);
  }

  async restore(ref: string, reason: string, correlationId?: string): Promise<ProjectWithAliases> {
    return this.setStatus(ref, 'active', 'core.project_restored', reason, correlationId);
  }

  private async setStatus(
    ref: string,
    status: ProjectStatus,
    topic: 'core.project_archived' | 'core.project_restored',
    reason: string,
    correlationId?: string,
  ): Promise<ProjectWithAliases> {
    const current = await this.resolve(ref);
    return withTransaction(this.deps.pool, async (tx) => {
      const locked = await this.deps.projects.lockById(tx, current.id);
      if (locked === null) throw new SagaError('PROJECT_NOT_FOUND', `No project matches "${ref}".`);
      if (locked.status === status) {
        const aliases = await this.deps.projects.listAliases(tx, locked.id);
        return { ...locked, aliases };
      }
      const project = await this.deps.projects.setStatus(tx, locked.id, status);
      await this.deps.outbox.emit(tx, {
        aggregateType: 'project',
        aggregateId: project.id,
        topic,
        payload: { project_id: project.id, name: project.name, reason },
        correlationId: correlationId ?? null,
        projectId: project.id,
      });
      const aliases = await this.deps.projects.listAliases(tx, project.id);
      return { ...project, aliases };
    });
  }

  async list(input: ListProjectsInput): Promise<Page<ProjectWithAliases>> {
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    const rows = await this.deps.projects.list(this.deps.pool, {
      status: input.status,
      search: input.search,
      cursorKey: cursor?.k,
      cursorId: cursor?.id,
      // Fetch one extra row to detect a further page without a COUNT.
      limit: input.limit + 1,
    });

    const aliasMap = await this.deps.projects.aliasesForProjects(
      this.deps.pool,
      rows.map((row) => row.id),
    );
    const withAliases: ProjectWithAliases[] = rows.map((row) => ({
      ...row,
      aliases: aliasMap.get(row.id) ?? [],
    }));

    return buildPage(withAliases, input.limit, (project) => ({
      k: project.nameKey,
      id: project.id,
    }));
  }

  async requireActive(ref: string): Promise<Project> {
    const project = await this.resolve(ref);
    if (project.status === 'archived') {
      throw new SagaError(
        'PROJECT_ARCHIVED',
        `The project "${project.name}" is archived and is read-only.`,
        { details: { project_id: project.id } },
      );
    }
    return project;
  }
}
