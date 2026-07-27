import type { Actor, AuthService, Permission } from '@saga/core';
import { actorKey, actorLabel, hashSecret, requirePermission } from '@saga/core';
import { SagaError } from '@saga/shared';
import { safeEqual } from '@saga/shared/ids';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'saga_session';
export const CSRF_COOKIE = 'saga_csrf';
export const CSRF_HEADER = 'x-saga-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
    actorKey: string;
    actorLabel: string;
    /** Throws unless the caller holds the permission. */
    requirePermission(permission: Permission): void;
  }
}

export interface AuthPluginOptions {
  auth: AuthService;
  devAuthBypass: boolean;
  cookieSecure: boolean;
  sessionTtlHours: number;
}

/**
 * Resolves one `request.actor` from either a session cookie or a bearer agent token, then
 * enforces CSRF for cookie-authenticated mutations (double-submit — see ADR-0003).
 */
export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  // `actor` is assigned per request by the hook below; only the shared method is decorated,
  // because Fastify v5 wants reference values set in a hook rather than pre-seeded.
  app.decorateRequest(
    'requirePermission',
    function requirePermissionImpl(this: FastifyRequest, permission: Permission) {
      requirePermission(this.actor, permission);
    },
  );

  app.addHook('onRequest', async (request) => {
    request.actor = await resolveActor(request, options);
    request.actorKey = actorKey(request.actor);
    request.actorLabel = actorLabel(request.actor);
  });

  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (request.actor.type !== 'user') return; // Bearer-token callers are not cookie-driven.
    if (options.devAuthBypass) return;

    const provided = request.headers[CSRF_HEADER];
    const cookie = request.cookies[CSRF_COOKIE];
    if (typeof provided !== 'string' || typeof cookie !== 'string' || !safeEqual(provided, cookie)) {
      throw new SagaError(
        'CSRF_TOKEN_INVALID',
        `A valid ${CSRF_HEADER} header matching the ${CSRF_COOKIE} cookie is required for this request.`,
      );
    }

    const session = await options.auth.resolveSession(request.cookies[SESSION_COOKIE] ?? '');
    if (session === null || !safeEqual(hashSecret(provided), session.csrfTokenHash)) {
      throw new SagaError('CSRF_TOKEN_INVALID', 'The CSRF token does not belong to this session.');
    }
  });
}

async function resolveActor(request: FastifyRequest, options: AuthPluginOptions): Promise<Actor> {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    const raw = authorization.slice(7).trim();
    if (raw.length > 0) {
      const agent = await options.auth.resolveAgentToken(raw);
      if (agent === null) {
        throw new SagaError('TOKEN_REVOKED', 'That agent token is not valid, has expired, or was revoked.');
      }
      return agent;
    }
  }

  const sessionId = request.cookies[SESSION_COOKIE];
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const session = await options.auth.resolveSession(sessionId);
    if (session !== null) return session.actor;
  }

  if (options.devAuthBypass) {
    // Only reachable when NODE_ENV is not production: `loadConfig` refuses the combination.
    return {
      type: 'user',
      userId: '00000000-0000-4000-8000-000000000000',
      email: 'dev-bypass@saga.local',
      displayName: 'Development bypass',
      role: 'admin',
      sessionId: 'dev-bypass',
    };
  }

  return { type: 'anonymous' };
}

export function setSessionCookies(
  reply: FastifyReply,
  input: { sessionId: string; csrfToken: string; secure: boolean; ttlHours: number },
): void {
  const maxAge = input.ttlHours * 3_600;
  void reply.setCookie(SESSION_COOKIE, input.sessionId, {
    httpOnly: true,
    secure: input.secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
  // Deliberately readable by the browser: the SPA echoes it back in the CSRF header.
  void reply.setCookie(CSRF_COOKIE, input.csrfToken, {
    httpOnly: false,
    secure: input.secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
  void reply.clearCookie(CSRF_COOKIE, { path: '/' });
}
