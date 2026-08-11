import {
  acquireClaimRequestSchema,
  heartbeatRequestSchema,
  projectRefParamsSchema,
  releaseClaimRequestSchema,
  reportFingerprintsRequestSchema,
  revokeClaimRequestSchema,
  startAgentRunRequestSchema,
} from '@saga/contracts';
import { SagaError } from '@saga/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../composition.js';
import { presentAgentRun, presentClaim } from '../lib/party-presenters.js';
import { resolveAccessibleProject } from '../lib/project-access.js';
import { withIdempotency } from '../plugins/idempotency.js';
import { parseOrThrow } from '../lib/validation.js';

export function registerPartyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const party = ctx.services.party;

  const idempotency = {
    pool: ctx.pool,
    records: ctx.repositories.idempotency,
    retentionHours: ctx.config.retention.idempotencyHours,
  };

  /**
   * Party can be switched off entirely. Reads still answer (so Guild Hall can say so), but
   * writes are refused with a code the agent can act on — Lore and Quest keep working.
   */
  const requireEnabled = (): void => {
    if (!party.enabled) {
      throw new SagaError(
        'PARTY_DISABLED',
        'Live coordination is disabled on this server (PARTY_MODE=off). Lore and Quest are unaffected.',
      );
    }
  };

  const assertRunVisible = async (
    request: { actor: { type: string; projectId?: string } },
    projectId: string,
  ): Promise<void> => {
    const actor = request.actor;
    if (actor.type === 'agent' && actor.projectId !== projectId) {
      throw new SagaError('AGENT_RUN_NOT_FOUND', 'No agent run matches that id.');
    }
  };

  // --- agent runs ----------------------------------------------------------

  app.post('/api/party/runs', async (request, reply) => {
    request.requirePermission('party:heartbeat');
    requireEnabled();
    const body = parseOrThrow(startAgentRunRequestSchema, request.body);

    const session = await ctx.services.sessions.get(body.session_id);
    await assertRunVisible(request, session.projectId);

    const run = await party.startRun({
      projectId: session.projectId,
      sessionId: body.session_id,
      agentInstanceId: body.agent_instance_id,
      client: body.client,
      workspaceKey: body.workspace_key ?? null,
      workspaceLabel: body.workspace_label ?? null,
      correlationId: request.id,
    });

    void reply.status(201);
    return { agent_run: presentAgentRun(run, new Date()) };
  });

  app.post('/api/party/runs/:runId/heartbeat', async (request) => {
    // Heartbeats are frequent; they are rate-limited generously and write no system event.
    request.requirePermission('party:heartbeat');
    requireEnabled();
    const { runId } = request.params as { runId: string };
    const body = parseOrThrow(heartbeatRequestSchema, request.body ?? {});

    const existing = await party.getRun(runId);
    await assertRunVisible(request, existing.projectId);

    const result = await party.heartbeat({
      agentRunId: runId,
      state: body.state,
      workItemId: body.work_item_id,
      renewClaims: body.renew_claims,
      activity: body.activity,
    });

    // The durable session is kept alive alongside the live run.
    await ctx.services.sessions.touch(result.run.sessionId).catch(() => undefined);

    return {
      agent_run: presentAgentRun(result.run, new Date()),
      renewed_claims: result.renewedClaims,
      overlaps: result.overlaps,
    };
  });

  app.post('/api/party/runs/:runId/end', async (request) => {
    request.requirePermission('party:heartbeat');
    requireEnabled();
    const { runId } = request.params as { runId: string };
    const existing = await party.getRun(runId);
    await assertRunVisible(request, existing.projectId);

    const result = await party.endRun({ agentRunId: runId, correlationId: request.id });
    return {
      agent_run: result.run === null ? null : presentAgentRun(result.run, new Date()),
      released_claims: result.releasedClaims,
    };
  });

  app.post('/api/party/runs/:runId/fingerprints', async (request) => {
    request.requirePermission('party:heartbeat');
    requireEnabled();
    const { runId } = request.params as { runId: string };
    const body = parseOrThrow(reportFingerprintsRequestSchema, request.body);

    const run = await party.getRun(runId);
    await assertRunVisible(request, run.projectId);

    // File coordination works without any version-control system: the agent reports paths
    // and hashes, and Saga compares them across Quests.
    return party.reportFingerprints({
      projectId: run.projectId,
      agentRunId: runId,
      workItemId: body.work_item_id,
      files: body.files,
    });
  });

  // --- claims --------------------------------------------------------------

  app.post('/api/party/claims', async (request, reply) => {
    request.requirePermission('party:claim');
    const body = parseOrThrow(acquireClaimRequestSchema, request.body);

    const run = await party.getRun(body.agent_run_id);
    await assertRunVisible(request, run.projectId);

    if (!party.enabled) {
      // Fail-closed resources must not proceed unguarded just because Party is off.
      if (party.isFailClosed(body.resource_type)) {
        throw new SagaError(
          'COORDINATION_UNAVAILABLE',
          party.unavailableGuidance(body.resource_type),
          { details: { resource_type: body.resource_type, party_mode: party.mode } },
        );
      }
      throw new SagaError(
        'PARTY_DISABLED',
        'Live coordination is disabled on this server (PARTY_MODE=off).',
      );
    }

    // Spec 12.7 names claim acquisition explicitly: an agent that retries after a timeout must
    // not be told the resource is taken by the claim its own first attempt already made.
    return withIdempotency(idempotency, request, reply, 'party.claim', async () => {
      const result = await party.acquireClaim({
        projectId: run.projectId,
        agentRunId: body.agent_run_id,
        workItemId: body.work_item_id,
        resourceType: body.resource_type,
        resourceKey: body.resource_key,
        mode: body.mode,
        baseFingerprint: body.base_fingerprint ?? null,
        leaseSeconds: body.lease_seconds,
        correlationId: request.id,
      });

      return {
        status: result.alreadyHeld ? 200 : 201,
        body: { claim: presentClaim(result.claim), warnings: result.warnings },
        resourceId: result.claim.id,
      };
    });
  });

  app.post('/api/party/claims/:claimId/renew', async (request) => {
    request.requirePermission('party:claim');
    requireEnabled();
    const { claimId } = request.params as { claimId: string };
    const body = request.body as { agent_run_id?: string };
    if (typeof body?.agent_run_id !== 'string') {
      throw new SagaError('BAD_REQUEST', 'agent_run_id is required to renew a claim.');
    }
    const run = await party.getRun(body.agent_run_id);
    await assertRunVisible(request, run.projectId);
    return { claim: presentClaim(await party.renewClaim(claimId, body.agent_run_id)) };
  });

  app.post('/api/party/claims/:claimId/release', async (request) => {
    request.requirePermission('party:claim');
    requireEnabled();
    const { claimId } = request.params as { claimId: string };
    const body = parseOrThrow(releaseClaimRequestSchema, request.body ?? {});
    const payload = request.body as { agent_run_id?: string };
    if (typeof payload?.agent_run_id !== 'string') {
      throw new SagaError('BAD_REQUEST', 'agent_run_id is required to release a claim.');
    }
    const run = await party.getRun(payload.agent_run_id);
    await assertRunVisible(request, run.projectId);

    const claim = await party.releaseClaim({
      claimId,
      agentRunId: payload.agent_run_id,
      reason: body.reason,
      correlationId: request.id,
    });
    return { claim: presentClaim(claim) };
  });

  app.post('/api/party/claims/:claimId/revoke', async (request) => {
    // Administrative revocation: confirmation, a reason, and an audit record are all required.
    request.requirePermission('party:revoke');
    requireEnabled();
    const { claimId } = request.params as { claimId: string };
    const body = parseOrThrow(revokeClaimRequestSchema, request.body ?? {});

    const claim = await party.revokeClaim({
      claimId,
      reason: body.reason,
      actorLabel: request.actorLabel,
      correlationId: request.id,
    });

    await ctx.services.audit.record({
      actorType: request.actor.type === 'user' ? 'user' : 'agent',
      actorId: request.actor.type === 'user' ? request.actor.userId : null,
      actorLabel: request.actorLabel,
      action: 'party.claim_revoked',
      entityType: 'claim',
      entityId: claimId,
      reason: body.reason,
      requestId: request.id,
      metadata: { resource_type: claim.resourceType, resource_key: claim.resourceKey },
    });

    return { claim: presentClaim(claim) };
  });

  // --- status --------------------------------------------------------------

  app.get('/api/projects/:projectRef/party/status', async (request) => {
    request.requirePermission('party:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);

    if (!party.enabled) {
      return {
        mode: party.mode,
        project_id: project.id,
        active_agents: [],
        claims: [],
        overlaps: [],
      };
    }

    const now = new Date();
    const status = await party.status(project.id);
    const snapshotByRun = new Map(
      status.snapshots.map((snapshot) => [snapshot.agentRunId, snapshot]),
    );

    return {
      mode: party.mode,
      project_id: project.id,
      active_agents: status.runs.map((run) => {
        const snapshot = snapshotByRun.get(run.id);
        return {
          ...presentAgentRun(run, now),
          quest_title: snapshot?.questTitle ?? null,
          scope: snapshot?.scope ?? {},
          claims: status.claims.filter((claim) => claim.agentRunId === run.id).map(presentClaim),
        };
      }),
      claims: status.claims.map(presentClaim),
      overlaps: status.overlaps,
    };
  });

  app.get('/api/projects/:projectRef/party/claims', async (request) => {
    request.requirePermission('party:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);
    const query = request.query as { include_finished?: string };
    const claims = await ctx.repositories.party.listClaimsForProject(
      ctx.pool,
      project.id,
      query.include_finished === 'true',
    );
    return { items: claims.map(presentClaim) };
  });

  app.get('/api/projects/:projectRef/party/runs', async (request) => {
    request.requirePermission('party:read');
    const params = parseOrThrow(projectRefParamsSchema, request.params, 'params');
    const project = await resolveAccessibleProject(ctx, request, params.projectRef);
    const now = new Date();
    const runs = await ctx.repositories.party.listRuns(ctx.pool, project.id, 50);
    return { items: runs.map((run) => presentAgentRun(run, now)) };
  });
}
