import { PERMISSIONS, type AgentScope, type Permission, type UserRole } from '@saga/contracts';
import { SagaError } from '@saga/shared';

export interface UserActor {
  type: 'user';
  userId: string;
  email: string;
  displayName: string;
  role: UserRole;
  sessionId: string;
}

export interface AgentActor {
  type: 'agent';
  tokenId: string;
  projectId: string;
  name: string;
  scopes: AgentScope[];
}

export interface AnonymousActor {
  type: 'anonymous';
}

export type Actor = UserActor | AgentActor | AnonymousActor;

/**
 * Web roles map to sets of permissions; agent scopes map separately, because an agent must
 * never inherit console-wide powers. The permission *names* live in `@saga/contracts` so
 * Guild Hall can read them; the matrices below are server-side policy.
 */
export { PERMISSIONS, type Permission };

const VIEWER: Permission[] = [
  'project:read',
  'lore:read',
  'quest:read',
  'party:read',
  'shrine:read',
];

const OPERATOR: Permission[] = [
  ...VIEWER,
  'project:write',
  'lore:propose',
  'lore:publish',
  'lore:archive',
  'quest:write',
  // An operator must not be *less* capable inside a project than an agent token issued for
  // it: driving a coordination flow by hand is part of operating the system.
  'party:heartbeat',
  'party:claim',
  'party:revoke',
  'shrine:operate',
];

const ADMIN: Permission[] = [...OPERATOR, 'project:archive', 'security:manage'];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  viewer: VIEWER,
  operator: OPERATOR,
  admin: ADMIN,
};

/** Agent scopes grant a strict subset: agents can never operate Shrine or manage security. */
const SCOPE_PERMISSIONS: Record<AgentScope, readonly Permission[]> = {
  'project:read': ['project:read', 'shrine:read'],
  'lore:read': ['lore:read'],
  'lore:propose': ['lore:propose'],
  'lore:publish': ['lore:publish'],
  'quest:read': ['quest:read'],
  'quest:write': ['quest:write', 'quest:read'],
  'party:heartbeat': ['party:heartbeat', 'party:read'],
  'party:claim': ['party:claim', 'party:read'],
};

export function permissionsFor(actor: Actor): Set<Permission> {
  if (actor.type === 'user') return new Set(ROLE_PERMISSIONS[actor.role]);
  if (actor.type === 'agent') {
    const granted = new Set<Permission>();
    for (const scope of actor.scopes) {
      for (const permission of SCOPE_PERMISSIONS[scope] ?? []) granted.add(permission);
    }
    return granted;
  }
  return new Set();
}

export function can(actor: Actor, permission: Permission): boolean {
  return permissionsFor(actor).has(permission);
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (actor.type === 'anonymous') {
    throw new SagaError('UNAUTHENTICATED', 'Authentication is required.');
  }
  if (!can(actor, permission)) {
    throw new SagaError(
      actor.type === 'agent' ? 'SCOPE_REQUIRED' : 'FORBIDDEN',
      actor.type === 'agent'
        ? `This agent token does not carry a scope granting "${permission}".`
        : `The ${actor.role} role does not permit "${permission}".`,
      { details: { permission } },
    );
  }
}

/**
 * An agent token is bound to exactly one project. This is the check that makes acceptance
 * criterion 23 true: a valid token for project A cannot read project B.
 */
export function requireProjectAccess(actor: Actor, projectId: string): void {
  if (actor.type === 'anonymous') {
    throw new SagaError('UNAUTHENTICATED', 'Authentication is required.');
  }
  if (actor.type === 'agent' && actor.projectId !== projectId) {
    throw new SagaError(
      'PROJECT_SCOPE_MISMATCH',
      'This agent token is bound to a different project.',
      { details: { requested_project_id: projectId } },
    );
  }
}

export function actorLabel(actor: Actor): string {
  switch (actor.type) {
    case 'user':
      return actor.email;
    case 'agent':
      return `agent:${actor.name}`;
    default:
      return 'anonymous';
  }
}

/** Stable key used to scope idempotency records to the caller that created them. */
export function actorKey(actor: Actor): string {
  switch (actor.type) {
    case 'user':
      return `user:${actor.userId}`;
    case 'agent':
      return `agent:${actor.tokenId}`;
    default:
      return 'anonymous';
  }
}
