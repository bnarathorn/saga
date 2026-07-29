import { AGENT_SCOPES, PERMISSIONS, type AgentScope, type Permission } from '@saga/contracts';
import { describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSIONS,
  actorKey,
  actorLabel,
  can,
  permissionsFor,
  requirePermission,
  requireProjectAccess,
  type AgentActor,
  type UserActor,
} from './authorization.js';

/**
 * The authorization matrix (spec 17.3), asserted in both directions.
 *
 * The negative assertions are the point: a permission accidentally added to `VIEWER`, or a
 * console-wide permission leaking into an agent scope, is the kind of change that passes every
 * other test in the repository.
 */

function user(role: 'viewer' | 'operator' | 'admin'): UserActor {
  return {
    type: 'user',
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'someone@saga.test',
    displayName: 'Someone',
    role,
    sessionId: 'session-1',
  };
}

function agent(scopes: AgentScope[]): AgentActor {
  return {
    type: 'agent',
    tokenId: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000010',
    name: 'erp agent',
    scopes,
  };
}

const READ_ONLY: Permission[] = [
  'project:read',
  'lore:read',
  'quest:read',
  'party:read',
  'shrine:health',
  'shrine:read',
];

/** Everything that changes state, which is exactly what a viewer must not be granted. */
const MUTATING = PERMISSIONS.filter((permission) => !READ_ONLY.includes(permission));

describe('web roles', () => {
  it('grants a viewer read access and nothing else', () => {
    for (const permission of READ_ONLY) {
      expect(can(user('viewer'), permission)).toBe(true);
    }
    for (const permission of MUTATING) {
      expect([permission, can(user('viewer'), permission)]).toEqual([permission, false]);
    }
  });

  it('nests the roles: operator ⊇ viewer, admin ⊇ operator', () => {
    const viewer = permissionsFor(user('viewer'));
    const operator = permissionsFor(user('operator'));
    const admin = permissionsFor(user('admin'));

    for (const permission of viewer) expect(operator.has(permission)).toBe(true);
    for (const permission of operator) expect(admin.has(permission)).toBe(true);
    expect(operator.size).toBeGreaterThan(viewer.size);
    expect(admin.size).toBeGreaterThan(operator.size);
  });

  it('reserves user, token and policy management for an admin', () => {
    for (const permission of ['security:manage', 'project:archive'] as const) {
      expect(can(user('admin'), permission)).toBe(true);
      expect(can(user('operator'), permission)).toBe(false);
      expect(can(user('viewer'), permission)).toBe(false);
    }
  });

  it('lets an operator perform the approved job and claim actions', () => {
    for (const permission of ['shrine:operate', 'party:claim', 'party:revoke'] as const) {
      expect(can(user('operator'), permission)).toBe(true);
      expect(can(user('viewer'), permission)).toBe(false);
    }
  });

  it('covers every declared permission somewhere in the matrix', () => {
    const admin = permissionsFor(user('admin'));
    for (const permission of PERMISSIONS) expect(admin.has(permission)).toBe(true);
  });

  it('grants an anonymous actor nothing at all', () => {
    expect(permissionsFor({ type: 'anonymous' }).size).toBe(0);
  });
});

describe('agent scopes', () => {
  const everyScope = agent([...AGENT_SCOPES]);

  it('never grants an agent the console-wide permissions', () => {
    // An agent token is bound to one project, and these are all server-wide.
    for (const permission of [
      'security:manage',
      'shrine:operate',
      'shrine:read',
      'project:write',
      'project:archive',
      'lore:archive',
      'party:revoke',
    ] as const) {
      expect([permission, can(everyScope, permission)]).toEqual([permission, false]);
    }
  });

  it('grants a strict subset of the operator role', () => {
    const operator = permissionsFor(user('operator'));
    for (const permission of permissionsFor(everyScope)) {
      expect([permission, operator.has(permission)]).toEqual([permission, true]);
    }
  });

  it('gives project:read the liveness probe but not the rest of Shrine', () => {
    const actor = agent(['project:read']);
    expect(can(actor, 'shrine:health')).toBe(true);
    // shrine:read would open the job queue and every project's system events.
    expect(can(actor, 'shrine:read')).toBe(false);
  });

  it('implies the matching read for each write scope', () => {
    expect(can(agent(['quest:write']), 'quest:read')).toBe(true);
    expect(can(agent(['party:claim']), 'party:read')).toBe(true);
    expect(can(agent(['party:heartbeat']), 'party:read')).toBe(true);
  });

  it('does not imply a write from a read', () => {
    expect(can(agent(['quest:read']), 'quest:write')).toBe(false);
    expect(can(agent(['lore:read']), 'lore:propose')).toBe(false);
    expect(can(agent(['lore:propose']), 'lore:publish')).toBe(false);
  });

  it('grants nothing for an empty scope list', () => {
    expect(permissionsFor(agent([])).size).toBe(0);
  });
});

describe('requirePermission', () => {
  it('distinguishes an unauthenticated caller from a forbidden one', () => {
    expect(() => requirePermission({ type: 'anonymous' }, 'lore:read')).toThrow(
      /Authentication is required/,
    );
    expect(() => requirePermission(user('viewer'), 'quest:write')).toThrow(
      /viewer role does not permit/,
    );
  });

  it('tells an agent it is missing a scope, not that it is the wrong role', () => {
    let code: string | undefined;
    try {
      requirePermission(agent(['lore:read']), 'quest:write');
    } catch (error) {
      code = (error as { code?: string }).code;
      expect((error as Error).message).toMatch(/does not carry a scope/);
    }
    expect(code).toBe('SCOPE_REQUIRED');
  });

  it('passes silently when the permission is held', () => {
    expect(() => requirePermission(user('admin'), 'security:manage')).not.toThrow();
  });
});

describe('requireProjectAccess', () => {
  const OTHER = '00000000-0000-4000-8000-000000000099';

  it('refuses a token bound to a different project (acceptance criterion 23)', () => {
    expect(() => requireProjectAccess(agent([]), OTHER)).toThrow(/bound to a different project/);
  });

  it('allows the project the token is bound to', () => {
    const actor = agent([]);
    expect(() => requireProjectAccess(actor, actor.projectId)).not.toThrow();
  });

  it('does not restrict a web user to one project', () => {
    expect(() => requireProjectAccess(user('viewer'), OTHER)).not.toThrow();
  });

  it('refuses an anonymous caller before it looks at the project', () => {
    expect(() => requireProjectAccess({ type: 'anonymous' }, OTHER)).toThrow(
      /Authentication is required/,
    );
  });
});

describe('actor identity', () => {
  it('labels each actor type distinguishably for the audit log', () => {
    expect(actorLabel(user('admin'))).toBe('someone@saga.test');
    expect(actorLabel(agent([]))).toBe('agent:erp agent');
    expect(actorLabel({ type: 'anonymous' })).toBe('anonymous');
  });

  it('scopes idempotency records to the caller, not merely to the actor type', () => {
    expect(actorKey(user('admin'))).toBe('user:00000000-0000-4000-8000-000000000001');
    expect(actorKey(agent([]))).toBe('agent:00000000-0000-4000-8000-000000000002');
    expect(actorKey({ type: 'anonymous' })).toBe('anonymous');
  });
});

describe('the matrix itself', () => {
  it('lists no permission that does not exist', () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of permissions) {
        expect([role, permission, PERMISSIONS.includes(permission)]).toEqual([
          role,
          permission,
          true,
        ]);
      }
    }
  });

  it('lists each permission at most once per role', () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect([role, new Set(permissions).size]).toEqual([role, permissions.length]);
    }
  });
});
