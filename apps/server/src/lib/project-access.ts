import type { Project } from '@saga/core';
import { SagaError } from '@saga/shared';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../composition.js';

/**
 * Resolve `projectRef` and enforce the agent-token project binding.
 *
 * A token scoped to another project gets 404, not 403: reporting "forbidden" would let a
 * token confirm that a project name exists, which is exactly the enumeration that
 * project-scoped tokens are meant to prevent.
 */
export async function resolveAccessibleProject(
  ctx: AppContext,
  request: FastifyRequest,
  projectRef: string,
): Promise<Project> {
  const project = await ctx.services.projects.resolve(projectRef);
  const actor = request.actor;
  if (actor.type === 'agent' && actor.projectId !== project.id) {
    throw new SagaError('PROJECT_NOT_FOUND', `No project matches "${projectRef}".`, {
      details: { project_ref: projectRef },
    });
  }
  return project;
}

/** As above, but also refuses archived projects for mutating operations. */
export async function resolveWritableProject(
  ctx: AppContext,
  request: FastifyRequest,
  projectRef: string,
): Promise<Project> {
  const project = await resolveAccessibleProject(ctx, request, projectRef);
  if (project.status === 'archived') {
    throw new SagaError(
      'PROJECT_ARCHIVED',
      `The project "${project.name}" is archived and is read-only. Restore it first.`,
      { details: { project_id: project.id } },
    );
  }
  return project;
}
