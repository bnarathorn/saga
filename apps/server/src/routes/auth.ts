import {
  createAgentTokenRequestSchema,
  deviceApproveRequestSchema,
  deviceStartRequestSchema,
  deviceStatusQuerySchema,
  loginRequestSchema,
  reasonRequestSchema,
  type CurrentUser,
  type DeviceStartResponse,
  type DeviceStatusResponse,
  type LoginResponse,
  type MeResponse,
} from '@saga/contracts';
import { DEFAULT_AGENT_SCOPES } from '@saga/core';
import { SagaError, toIso } from '@saga/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../composition.js';
import { presentAgentToken } from '../lib/presenters.js';
import { parseOrThrow } from '../lib/validation.js';
import { CSRF_COOKIE, clearSessionCookies, setSessionCookies, SESSION_COOKIE } from '../plugins/auth.js';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { auth, audit } = ctx.services;
  const secure = ctx.config.security.cookieSecure;
  const ttlHours = ctx.config.security.sessionTtlHours;

  app.post('/api/auth/login', {
    config: { rateLimit: { max: ctx.config.security.loginRateLimitPerMinute, timeWindow: '1 minute' } },
    handler: async (request, reply): Promise<LoginResponse> => {
      const body = parseOrThrow(loginRequestSchema, request.body);
      const result = await auth.login({
        email: body.email,
        password: body.password,
        userAgent: request.headers['user-agent'] ?? null,
        ipAddress: request.ip,
      });

      // Session rotation: a fresh id is minted on every successful authentication.
      setSessionCookies(reply, {
        sessionId: result.sessionId,
        csrfToken: result.csrfToken,
        secure,
        ttlHours,
      });

      await audit.record({
        actorType: 'user',
        actorId: result.user.id,
        actorLabel: result.user.email,
        action: 'auth.login',
        requestId: request.id,
      });

      return {
        user: toCurrentUser(result.user),
        csrf_token: result.csrfToken,
        expires_at: result.expiresAt.toISOString(),
      };
    },
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      await auth.logout(sessionId);
    }
    clearSessionCookies(reply);
    return { ok: true as const };
  });

  app.get('/api/auth/me', async (request): Promise<MeResponse> => {
    const actor = request.actor;
    if (actor.type === 'user') {
      return {
        authenticated: true,
        actor_type: 'user',
        user: {
          id: actor.userId,
          email: actor.email,
          display_name: actor.displayName,
          role: actor.role,
          last_login_at: null,
        },
        agent: null,
        csrf_token: request.cookies[CSRF_COOKIE] ?? null,
      };
    }
    if (actor.type === 'agent') {
      return {
        authenticated: true,
        actor_type: 'agent',
        user: null,
        agent: {
          token_id: actor.tokenId,
          project_id: actor.projectId,
          name: actor.name,
          scopes: actor.scopes,
        },
        csrf_token: null,
      };
    }
    return { authenticated: false, actor_type: 'anonymous', user: null, agent: null, csrf_token: null };
  });

  // --- device flow ---------------------------------------------------------

  app.post('/api/auth/device/start', {
    config: { rateLimit: { max: ctx.config.security.deviceRateLimitPerMinute, timeWindow: '1 minute' } },
    handler: async (request): Promise<DeviceStartResponse> => {
      const body = parseOrThrow(deviceStartRequestSchema, request.body);
      const started = await auth.startDeviceFlow({
        client: body.client,
        workspaceLabel: body.workspace_label ?? null,
        scopes: body.scopes ?? DEFAULT_AGENT_SCOPES,
      });
      return {
        device_code: started.deviceCode,
        user_code: started.record.userCode,
        verification_uri: started.verificationUri,
        verification_uri_complete: `${started.verificationUri}?code=${encodeURIComponent(started.record.userCode)}`,
        expires_at: started.record.expiresAt.toISOString(),
        interval_seconds: started.intervalSeconds,
      };
    },
  });

  app.get('/api/auth/device/pending', async (request) => {
    request.requirePermission('security:manage');
    const pending = await auth.listPendingDeviceCodes();
    return {
      items: pending.map((record) => ({
        user_code: record.userCode,
        client: record.client,
        workspace_label: record.workspaceLabel,
        requested_scopes: record.requestedScopes,
        expires_at: record.expiresAt.toISOString(),
      })),
    };
  });

  app.post('/api/auth/device/approve', async (request) => {
    request.requirePermission('security:manage');
    const body = parseOrThrow(deviceApproveRequestSchema, request.body);
    const project = await ctx.services.projects.resolve(body.project_ref);
    const actor = request.actor;
    if (actor.type !== 'user') {
      throw new SagaError('FORBIDDEN', 'Only a signed-in user can approve a device request.');
    }

    const token = await auth.approveDeviceFlow({
      userCode: body.user_code,
      projectId: project.id,
      projectNameKey: project.nameKey,
      approvedBy: actor.userId,
      tokenName: body.token_name ?? `${project.name} agent`,
      scopes: body.scopes,
      expiresInDays: body.expires_in_days,
    });

    await audit.record({
      actorType: 'user',
      actorId: actor.userId,
      actorLabel: actor.email,
      action: 'auth.device_approved',
      projectId: project.id,
      entityType: 'agent_token',
      entityId: token.id,
      requestId: request.id,
      metadata: { scopes: token.scopes, client: token.client },
    });

    return { token: presentAgentToken(token) };
  });

  app.get('/api/auth/device/status', {
    config: { rateLimit: { max: ctx.config.security.deviceRateLimitPerMinute * 6, timeWindow: '1 minute' } },
    handler: async (request, reply): Promise<DeviceStatusResponse> => {
      const query = parseOrThrow(deviceStatusQuerySchema, request.query, 'query');
      const status = await auth.pollDeviceFlow(query.device_code);

      let project: { id: string; name: string } | null = null;
      if (status.projectId !== null) {
        const record = await ctx.services.projects.tryResolve(status.projectId);
        project = record === null ? null : { id: record.id, name: record.name };
      }

      // 202 tells a polling CLI "keep waiting" without it having to parse the body.
      if (status.state === 'pending') void reply.status(202);

      return {
        state: status.state,
        token: status.token,
        project,
        scopes: status.scopes,
        expires_at: toIso(status.expiresAt),
      };
    },
  });

  // --- agent tokens --------------------------------------------------------

  app.get('/api/projects/:projectRef/tokens', async (request) => {
    request.requirePermission('security:manage');
    const { projectRef } = request.params as { projectRef: string };
    const project = await ctx.services.projects.resolve(projectRef);
    const tokens = await auth.listAgentTokens(project.id);
    return { items: tokens.map(presentAgentToken) };
  });

  app.post('/api/projects/:projectRef/tokens', async (request, reply) => {
    request.requirePermission('security:manage');
    const { projectRef } = request.params as { projectRef: string };
    const body = parseOrThrow(createAgentTokenRequestSchema, request.body);
    const project = await ctx.services.projects.resolve(projectRef);
    const actor = request.actor;

    const created = await auth.createAgentToken({
      projectId: project.id,
      projectNameKey: project.nameKey,
      createdBy: actor.type === 'user' ? actor.userId : null,
      name: body.name,
      scopes: body.scopes,
      client: body.client ?? null,
      expiresInDays: body.expires_in_days,
    });

    await audit.record({
      actorType: actor.type === 'user' ? 'user' : 'agent',
      actorId: actor.type === 'user' ? actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'auth.token_created',
      projectId: project.id,
      entityType: 'agent_token',
      entityId: created.record.id,
      requestId: request.id,
      metadata: { scopes: body.scopes },
    });

    void reply.status(201);
    // The raw token is returned exactly once; only its hash is stored.
    return { token: presentAgentToken(created.record), raw_token: created.rawToken };
  });

  app.post('/api/tokens/:tokenId/revoke', async (request) => {
    request.requirePermission('security:manage');
    const { tokenId } = request.params as { tokenId: string };
    const body = parseOrThrow(reasonRequestSchema, request.body ?? {});
    const actor = request.actor;
    const token = await auth.revokeAgentToken(tokenId, actor.type === 'user' ? actor.userId : null);
    await audit.record({
      actorType: actor.type === 'user' ? 'user' : 'agent',
      actorId: actor.type === 'user' ? actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'auth.token_revoked',
      projectId: token.projectId,
      entityType: 'agent_token',
      entityId: token.id,
      reason: body.reason,
      requestId: request.id,
    });
    return { token: presentAgentToken(token) };
  });
}

function toCurrentUser(user: {
  id: string;
  email: string;
  displayName: string;
  role: CurrentUser['role'];
  lastLoginAt: Date | null;
}): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    role: user.role,
    last_login_at: toIso(user.lastLoginAt),
  };
}
