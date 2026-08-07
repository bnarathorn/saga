import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  agentTokenSchema,
  createAgentTokenRequestSchema,
  createAgentTokenResponseSchema,
  deviceApproveRequestSchema,
  deviceStartRequestSchema,
  deviceStartResponseSchema,
  deviceStatusResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
} from './auth.js';
import { errorEnvelopeSchema, reasonRequestSchema } from './common.js';
import {
  contextRequestSchema,
  contextResponseSchema,
  contextSnapshotSchema,
  createLinkRequestSchema,
  evidenceCheckRequestSchema,
  evidenceCheckResponseSchema,
  loreEntrySchema,
  loreSearchRequestSchema,
  loreSearchResponseSchema,
  markStaleRequestSchema,
  memoryLinkSchema,
  memoryUpdateSchema,
  memoryVersionSchema,
  rememberRequestSchema,
} from './lore.js';
import {
  acquireClaimRequestSchema,
  agentRunSchema,
  claimSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  partyStatusSchema,
  releaseClaimRequestSchema,
  reportFingerprintsRequestSchema,
  reportFingerprintsResponseSchema,
  revokeClaimRequestSchema,
  startAgentRunRequestSchema,
} from './party.js';
import {
  archiveProjectRequestSchema,
  createProjectRequestSchema,
  projectSchema,
  projectSummarySchema,
  updateProjectRequestSchema,
} from './projects.js';
import {
  activateSessionRequestSchema,
  activateSessionResponseSchema,
  checkpointSchema,
  createCheckpointRequestSchema,
  createCheckpointResponseSchema,
  createDependencyRequestSchema,
  createQuestRequestSchema,
  endSessionRequestSchema,
  endSessionResponseSchema,
  promoteSessionRequestSchema,
  questPlanSchema,
  questSchema,
  sessionSchema,
  setQuestPlanRequestSchema,
  startSessionRequestSchema,
  startSessionResponseSchema,
  updateQuestRequestSchema,
  workStateSchema,
} from './quest.js';
import {
  auditLogSchema,
  enqueueProbeRequestSchema,
  jobActionRequestSchema,
  jobSchema,
  metricsSummarySchema,
  schemaVersionSchema,
  serviceInstanceSchema,
  shrineConfigSchema,
  shrineHealthSchema,
  systemEventSchema,
} from './shrine.js';

extendZodWithOpenApi(z);

/**
 * The OpenAPI document is generated from the same Zod contracts the API validates with, so
 * it cannot drift: `pnpm openapi:check` fails CI when the committed file is stale.
 */
export function buildOpenApiDocument(version = '0.1.0'): Record<string, unknown> {
  const registry = new OpenAPIRegistry();

  const bearer = registry.registerComponent('securitySchemes', 'agentToken', {
    type: 'http',
    scheme: 'bearer',
    description:
      'A project-scoped agent token (`saga_<project>_<secret>`). Bound to exactly one project and to an explicit scope list.',
  });
  const cookie = registry.registerComponent('securitySchemes', 'webSession', {
    type: 'apiKey',
    in: 'cookie',
    name: 'saga_session',
    description:
      'Opaque, server-side web session. Mutations additionally require the `X-Saga-CSRF` header to match the `saga_csrf` cookie.',
  });

  const auth = [{ [bearer.name]: [] }, { [cookie.name]: [] }];

  const errorResponse = (description: string) => ({
    description,
    content: { 'application/json': { schema: errorEnvelopeSchema } },
  });

  const json = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });

  const route = (config: {
    method: 'get' | 'post' | 'put' | 'patch' | 'delete';
    path: string;
    tags: string[];
    summary: string;
    description?: string;
    // The generator's parameter types are narrower than ZodTypeAny; every call site passes a
    // ZodObject, so the registration below casts once rather than threading generics.
    request?: { body?: z.ZodTypeAny; params?: z.AnyZodObject; query?: z.AnyZodObject };
    responses: Partial<Record<number, { description: string; schema?: z.ZodTypeAny }>>;
    secured?: boolean;
  }) => {
    const responses: Record<string, unknown> = {};
    for (const [status, value] of Object.entries(config.responses)) {
      if (value === undefined) continue;
      responses[status] = {
        description: value.description,
        ...(value.schema === undefined ? {} : { content: json(value.schema) }),
      };
    }
    responses['401'] = errorResponse('Authentication is required.');
    responses['403'] = errorResponse('The caller lacks the required role or scope.');
    responses['422'] = errorResponse('The request was semantically invalid.');
    responses['500'] = errorResponse('An internal error occurred.');

    registry.registerPath({
      method: config.method,
      path: config.path,
      tags: config.tags,
      summary: config.summary,
      ...(config.description === undefined ? {} : { description: config.description }),
      ...(config.secured === false ? {} : { security: auth }),
      request: {
        ...(config.request?.body === undefined
          ? {}
          : { body: { content: json(config.request.body) } }),
        ...(config.request?.params === undefined ? {} : { params: config.request.params }),
        ...(config.request?.query === undefined ? {} : { query: config.request.query }),
      },
      responses: responses as never,
    });
  };

  const projectRef = z.object({
    projectRef: z.string().openapi({
      description: 'A UUID, the current name, its normalized form, or a former alias.',
      example: 'ERP Backoffice',
    }),
  });

  // --- health --------------------------------------------------------------
  route({
    method: 'get',
    path: '/health/live',
    tags: ['Shrine'],
    summary: 'Liveness probe',
    description:
      'Answers without touching the database, so a database outage cannot cause restarts.',
    secured: false,
    responses: {
      200: {
        description: 'The process is alive.',
        schema: z.object({ status: z.literal('ok'), uptime_seconds: z.number() }),
      },
    },
  });
  route({
    method: 'get',
    path: '/health/ready',
    tags: ['Shrine'],
    summary: 'Readiness probe',
    description: 'Checks database connectivity, schema version and required configuration.',
    secured: false,
    responses: {
      200: { description: 'Ready to serve.' },
      503: { description: 'Not ready.' },
    },
  });

  // --- auth ----------------------------------------------------------------
  route({
    method: 'post',
    path: '/api/auth/login',
    tags: ['Security'],
    summary: 'Sign in to Guild Hall',
    secured: false,
    request: { body: loginRequestSchema },
    responses: { 200: { description: 'Signed in.', schema: loginResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/auth/logout',
    tags: ['Security'],
    summary: 'Sign out and revoke the session server-side',
    responses: { 200: { description: 'Signed out.' } },
  });
  route({
    method: 'get',
    path: '/api/auth/me',
    tags: ['Security'],
    summary: 'Describe the current actor',
    secured: false,
    responses: { 200: { description: 'The current actor.', schema: meResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/auth/device/start',
    tags: ['Security'],
    summary: 'Begin the CLI device-authorization flow',
    secured: false,
    request: { body: deviceStartRequestSchema },
    responses: { 200: { description: 'Device code issued.', schema: deviceStartResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/auth/device/approve',
    tags: ['Security'],
    summary: 'Approve a device request and mint a project-scoped token',
    request: { body: deviceApproveRequestSchema },
    responses: { 200: { description: 'Approved.', schema: z.object({ token: agentTokenSchema }) } },
  });
  route({
    method: 'get',
    path: '/api/auth/device/status',
    tags: ['Security'],
    summary: 'Poll a device authorization',
    description: 'The raw token is returned exactly once, on the first poll after approval.',
    secured: false,
    request: { query: z.object({ device_code: z.string() }) },
    responses: {
      200: {
        description: 'Approved; the token is included once.',
        schema: deviceStatusResponseSchema,
      },
      202: { description: 'Still pending.', schema: deviceStatusResponseSchema },
    },
  });
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/tokens',
    tags: ['Security'],
    summary: 'Issue a project-scoped agent token',
    description: 'The raw token is shown once; only a hash is stored.',
    request: { params: projectRef, body: createAgentTokenRequestSchema },
    responses: { 201: { description: 'Token created.', schema: createAgentTokenResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/tokens/{tokenId}/revoke',
    tags: ['Security'],
    summary: 'Revoke an agent token',
    request: { params: z.object({ tokenId: z.string().uuid() }), body: reasonRequestSchema },
    responses: { 200: { description: 'Revoked.', schema: z.object({ token: agentTokenSchema }) } },
  });

  // --- projects ------------------------------------------------------------
  route({
    method: 'get',
    path: '/api/projects',
    tags: ['Projects'],
    summary: 'List projects',
    responses: {
      200: {
        description: 'A cursor-paginated page.',
        schema: z.object({
          items: z.array(projectSummarySchema),
          next_cursor: z.string().nullable(),
          has_more: z.boolean(),
        }),
      },
    },
  });
  route({
    method: 'post',
    path: '/api/projects',
    tags: ['Projects'],
    summary: 'Create a project',
    description:
      'A project is created from a name alone. Repository URL, branch, commit and remote are deliberately not accepted.',
    request: { body: createProjectRequestSchema },
    responses: {
      201: { description: 'Created.', schema: z.object({ project: projectSchema }) },
      409: {
        description: 'A project with an equivalent name already exists.',
        schema: errorEnvelopeSchema,
      },
    },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}',
    tags: ['Projects'],
    summary: 'Read a project',
    request: { params: projectRef },
    responses: {
      200: { description: 'The project.', schema: z.object({ project: projectSummarySchema }) },
    },
  });
  route({
    method: 'patch',
    path: '/api/projects/{projectRef}',
    tags: ['Projects'],
    summary: 'Rename or update a project',
    description: 'Renaming preserves the UUID and records the previous name as an alias.',
    request: { params: projectRef, body: updateProjectRequestSchema },
    responses: { 200: { description: 'Updated.', schema: z.object({ project: projectSchema }) } },
  });
  for (const action of ['archive', 'restore'] as const) {
    route({
      method: 'post',
      path: `/api/projects/{projectRef}/${action}`,
      tags: ['Projects'],
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} a project`,
      request: { params: projectRef, body: archiveProjectRequestSchema },
      responses: { 200: { description: 'Done.', schema: z.object({ project: projectSchema }) } },
    });
  }

  // --- lore ----------------------------------------------------------------
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/lore',
    tags: ['Lore'],
    summary: 'List Lore Entries',
    request: { params: projectRef },
    responses: {
      200: {
        description: 'A page of entries plus the project memory revision.',
        schema: z.object({
          items: z.array(loreEntrySchema),
          next_cursor: z.string().nullable(),
          has_more: z.boolean(),
          memory_revision: z.number().int(),
        }),
      },
    },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/lore/{memoryKey}',
    tags: ['Lore'],
    summary: 'Read one Lore Entry',
    request: { params: projectRef.extend({ memoryKey: z.string() }) },
    responses: {
      200: {
        description: 'The entry and its relations.',
        schema: z.object({ entry: loreEntrySchema, links: z.array(memoryLinkSchema) }),
      },
    },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/lore/{memoryKey}/versions',
    tags: ['Lore'],
    summary: 'List the immutable version history of an entry',
    request: { params: projectRef.extend({ memoryKey: z.string() }) },
    responses: {
      200: {
        description: 'Versions, newest first.',
        schema: z.object({
          items: z.array(memoryVersionSchema),
          current_version_id: z.string().uuid().nullable(),
        }),
      },
    },
  });
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/lore/search',
    tags: ['Lore'],
    summary: 'Search Lore',
    description:
      'Full-text, trigram and vector channels fused by reciprocal rank. If the embedding provider is unavailable the response is marked `degraded` rather than failing.',
    request: { params: projectRef, body: loreSearchRequestSchema },
    responses: { 200: { description: 'Ranked results.', schema: loreSearchResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/lore/remember',
    tags: ['Lore'],
    summary: 'Propose Lore Entries',
    description:
      'Creates a candidate update. It never overwrites current Lore directly. Supports `Idempotency-Key`.',
    request: { params: projectRef, body: rememberRequestSchema },
    responses: {
      202: {
        description: 'Candidate accepted and queued for validation.',
        schema: z.object({
          update: memoryUpdateSchema,
          approval_mode: z.string(),
          message: z.string(),
        }),
      },
    },
  });
  for (const action of ['validate', 'publish', 'cancel'] as const) {
    route({
      method: 'post',
      path: `/api/lore/updates/{updateId}/${action}`,
      tags: ['Lore'],
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} a Lore update`,
      ...(action === 'publish'
        ? {
            description:
              'Publishes atomically: every affected entry is locked in id order and its current pointer compared with the proposed base. Any mismatch changes nothing and returns 409.',
          }
        : {}),
      request: {
        params: z.object({ updateId: z.string().uuid() }),
        ...(action === 'cancel' ? { body: reasonRequestSchema } : {}),
      },
      responses: {
        200: { description: 'Done.', schema: z.object({ update: memoryUpdateSchema }) },
        ...(action === 'publish'
          ? {
              409: {
                description: 'One or more entries changed since the proposal.',
                schema: errorEnvelopeSchema,
              },
            }
          : {}),
      },
    });
  }
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/lore/{memoryKey}/mark-stale',
    tags: ['Lore'],
    summary: 'Mark a Lore Entry stale',
    description: 'Nothing is deleted: the entry keeps its content and gains a reason.',
    request: { params: projectRef.extend({ memoryKey: z.string() }), body: markStaleRequestSchema },
    responses: {
      200: { description: 'Marked stale.', schema: z.object({ entry: loreEntrySchema }) },
    },
  });
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/lore/{memoryKey}/archive',
    tags: ['Lore'],
    summary: 'Archive a Lore Entry',
    request: { params: projectRef.extend({ memoryKey: z.string() }), body: reasonRequestSchema },
    responses: { 200: { description: 'Archived.', schema: z.object({ entry: loreEntrySchema }) } },
  });
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/lore/evidence/check',
    tags: ['Lore'],
    summary: 'Report local file observations and detect drift',
    description: 'The server never reads the caller’s filesystem; the CLI or agent reports hashes.',
    request: { params: projectRef, body: evidenceCheckRequestSchema },
    responses: { 200: { description: 'Drift report.', schema: evidenceCheckResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/lore-links',
    tags: ['Lore'],
    summary: 'Create a relation between two Lore Entries',
    request: { params: projectRef, body: createLinkRequestSchema },
    responses: { 201: { description: 'Created.', schema: z.object({ link: memoryLinkSchema }) } },
  });
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/context',
    tags: ['Lore'],
    summary: 'Compose agent context',
    description: 'Core, Task and (for resume_work) Continuation layers, plus Party coordination.',
    request: { params: projectRef, body: contextRequestSchema },
    responses: { 200: { description: 'Composed context.', schema: contextResponseSchema } },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/context/snapshot',
    tags: ['Lore'],
    summary: 'Read the active core context snapshot',
    request: { params: projectRef },
    responses: {
      200: {
        description: 'The active snapshot, or bootstrap guidance when there is none.',
        schema: z.object({
          snapshot: contextSnapshotSchema.nullable(),
          bootstrap_plan: z.unknown(),
        }),
      },
    },
  });

  // --- quest ---------------------------------------------------------------
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/quests',
    tags: ['Quest'],
    summary: 'List Quests',
    request: { params: projectRef },
    responses: {
      200: {
        description: 'A cursor-paginated page.',
        schema: z.object({
          items: z.array(questSchema),
          next_cursor: z.string().nullable(),
          has_more: z.boolean(),
        }),
      },
    },
  });
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/quests',
    tags: ['Quest'],
    summary: 'Create a Quest',
    request: { params: projectRef, body: createQuestRequestSchema },
    responses: { 201: { description: 'Created.', schema: z.object({ quest: questSchema }) } },
  });
  route({
    method: 'get',
    path: '/api/quests/{questId}',
    tags: ['Quest'],
    summary: 'Read a Quest with its Questline, dependencies, checkpoints and sessions',
    request: { params: z.object({ questId: z.string().uuid() }) },
    responses: {
      200: {
        description: 'The Quest detail view.',
        schema: z.object({
          quest: questSchema,
          children: z.array(questSchema),
          dependencies: z.array(z.record(z.unknown())),
          checkpoints: z.array(checkpointSchema),
          sessions: z.array(sessionSchema),
          latest_handoff: checkpointSchema.nullable(),
        }),
      },
    },
  });
  route({
    method: 'patch',
    path: '/api/quests/{questId}',
    tags: ['Quest'],
    summary: 'Update a Quest',
    request: { params: z.object({ questId: z.string().uuid() }), body: updateQuestRequestSchema },
    responses: { 200: { description: 'Updated.', schema: z.object({ quest: questSchema }) } },
  });
  route({
    method: 'post',
    path: '/api/quests/{questId}/reopen',
    tags: ['Quest'],
    summary: 'Reopen a completed or cancelled Quest',
    description: 'Requires a reason; recorded in the audit log.',
    request: { params: z.object({ questId: z.string().uuid() }), body: reasonRequestSchema },
    responses: { 200: { description: 'Reopened.', schema: z.object({ quest: questSchema }) } },
  });
  route({
    method: 'post',
    path: '/api/quests/{questId}/dependencies',
    tags: ['Quest'],
    summary: 'Add a dependency',
    description: 'Self-dependencies, cross-project dependencies and cycles are rejected.',
    request: {
      params: z.object({ questId: z.string().uuid() }),
      body: createDependencyRequestSchema,
    },
    responses: {
      201: {
        description: 'Created.',
        schema: z.object({ dependencies: z.array(z.record(z.unknown())) }),
      },
    },
  });

  route({
    method: 'post',
    path: '/api/sessions',
    tags: ['Quest'],
    summary: 'Open a session (phase one)',
    description:
      'Returns short Core Context and open Quests as *suggestions*. No Quest is attached and no handoff is loaded: that happens at activation, once the first task is known.',
    request: { body: startSessionRequestSchema },
    responses: { 201: { description: 'Session opened.', schema: startSessionResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/sessions/{sessionId}/activate',
    tags: ['Quest'],
    summary: 'Activate a session on its first task (phase two)',
    description:
      'Classifies the task as new_work, resume_work or inquiry, creates or attaches a Quest, and returns Core, Task and (for resume_work) Continuation context.',
    request: {
      params: z.object({ sessionId: z.string().uuid() }),
      body: activateSessionRequestSchema,
    },
    responses: { 200: { description: 'Activated.', schema: activateSessionResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/sessions/{sessionId}/promote',
    tags: ['Quest'],
    summary: 'Promote an inquiry session to real work',
    request: {
      params: z.object({ sessionId: z.string().uuid() }),
      body: promoteSessionRequestSchema,
    },
    responses: { 200: { description: 'Promoted.', schema: activateSessionResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/sessions/{sessionId}/checkpoints',
    tags: ['Quest'],
    summary: 'Record a checkpoint',
    description:
      'Compare-and-swap on the Quest revision. A stale expected revision returns 409 with the latest revision attached; the latest checkpoint is never overwritten.',
    request: {
      params: z.object({ sessionId: z.string().uuid() }),
      body: createCheckpointRequestSchema,
    },
    responses: {
      201: { description: 'Recorded.', schema: createCheckpointResponseSchema },
      409: {
        description: 'The Quest changed since this checkpoint was prepared.',
        schema: errorEnvelopeSchema,
      },
    },
  });
  route({
    method: 'post',
    path: '/api/sessions/{sessionId}/end',
    tags: ['Quest'],
    summary: 'End a session with a final handoff',
    request: { params: z.object({ sessionId: z.string().uuid() }), body: endSessionRequestSchema },
    responses: { 200: { description: 'Ended.', schema: endSessionResponseSchema } },
  });

  // --- party ---------------------------------------------------------------
  route({
    method: 'post',
    path: '/api/party/runs',
    tags: ['Party'],
    summary: 'Start an agent run',
    request: { body: startAgentRunRequestSchema },
    responses: {
      201: { description: 'Started.', schema: z.object({ agent_run: agentRunSchema }) },
      503: {
        description: 'Coordination is disabled (PARTY_MODE=off).',
        schema: errorEnvelopeSchema,
      },
    },
  });
  route({
    method: 'post',
    path: '/api/party/runs/{runId}/heartbeat',
    tags: ['Party'],
    summary: 'Renew the agent-run lease',
    description: 'Idempotent. Writes no system event, so heartbeats cannot bury real signals.',
    request: { params: z.object({ runId: z.string().uuid() }), body: heartbeatRequestSchema },
    responses: { 200: { description: 'Renewed.', schema: heartbeatResponseSchema } },
  });
  route({
    method: 'post',
    path: '/api/party/runs/{runId}/fingerprints',
    tags: ['Party'],
    summary: 'Report file fingerprints',
    description: 'File coordination that works without any version-control system.',
    request: {
      params: z.object({ runId: z.string().uuid() }),
      body: reportFingerprintsRequestSchema,
    },
    responses: {
      200: {
        description: 'Recorded, with any conflicts.',
        schema: reportFingerprintsResponseSchema,
      },
    },
  });
  route({
    method: 'post',
    path: '/api/party/claims',
    tags: ['Party'],
    summary: 'Acquire a resource claim',
    description:
      'One transaction: lock the resource, expire stale claims, evaluate the policy, then insert or refuse.',
    request: { body: acquireClaimRequestSchema },
    responses: {
      201: {
        description: 'Granted.',
        schema: z.object({ claim: claimSchema, warnings: z.array(z.string()) }),
      },
      409: { description: 'Another agent holds the resource.', schema: errorEnvelopeSchema },
    },
  });
  route({
    method: 'post',
    path: '/api/party/claims/{claimId}/release',
    tags: ['Party'],
    summary: 'Release a claim you hold',
    request: { params: z.object({ claimId: z.string().uuid() }), body: releaseClaimRequestSchema },
    responses: { 200: { description: 'Released.', schema: z.object({ claim: claimSchema }) } },
  });
  route({
    method: 'post',
    path: '/api/party/claims/{claimId}/revoke',
    tags: ['Party'],
    summary: 'Revoke a claim administratively',
    description: 'Requires explicit confirmation and a reason; recorded in the audit log.',
    request: { params: z.object({ claimId: z.string().uuid() }), body: revokeClaimRequestSchema },
    responses: { 200: { description: 'Revoked.', schema: z.object({ claim: claimSchema }) } },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/party/status',
    tags: ['Party'],
    summary: 'Live coordination state for a project',
    request: { params: projectRef },
    responses: { 200: { description: 'Party status.', schema: partyStatusSchema } },
  });

  // --- shrine --------------------------------------------------------------
  route({
    method: 'get',
    path: '/api/shrine/health',
    tags: ['Shrine'],
    summary: 'Full health model',
    responses: { 200: { description: 'Health report.', schema: shrineHealthSchema } },
  });
  route({
    method: 'get',
    path: '/api/shrine/services',
    tags: ['Shrine'],
    summary: 'Registered API, worker and scheduler instances',
    description: 'Liveness is derived from the lease, not from the stored state column.',
    responses: {
      200: {
        description: 'Instances.',
        schema: z.object({ items: z.array(serviceInstanceSchema) }),
      },
    },
  });
  route({
    method: 'get',
    path: '/api/shrine/jobs',
    tags: ['Shrine'],
    summary: 'List background jobs',
    responses: {
      200: {
        description: 'A page of jobs with summarised payloads.',
        schema: z.object({
          items: z.array(jobSchema),
          next_cursor: z.string().nullable(),
          has_more: z.boolean(),
        }),
      },
    },
  });
  for (const action of ['retry', 'cancel', 'requeue'] as const) {
    route({
      method: 'post',
      path: `/api/shrine/jobs/{jobId}/${action}`,
      tags: ['Shrine'],
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} a job`,
      description: 'Requires a reason; recorded in the audit log.',
      request: { params: z.object({ jobId: z.string().uuid() }), body: jobActionRequestSchema },
      responses: { 200: { description: 'Done.', schema: z.object({ job: jobSchema }) } },
    });
  }
  route({
    method: 'post',
    path: '/api/shrine/jobs/probe',
    tags: ['Shrine'],
    summary: 'Queue a deterministic no-op job',
    description:
      'Proves the queue drains end to end. Deliberately limited to one job type: Shrine is not a job-payload editor or a command runner.',
    request: { body: enqueueProbeRequestSchema },
    responses: { 201: { description: 'Queued.', schema: z.object({ job: jobSchema }) } },
  });
  route({
    method: 'get',
    path: '/api/shrine/events',
    tags: ['Shrine'],
    summary: 'System activity feed',
    responses: {
      200: {
        description: 'Events, newest first.',
        schema: z.object({
          items: z.array(systemEventSchema),
          next_cursor: z.string().nullable(),
          has_more: z.boolean(),
        }),
      },
    },
  });
  route({
    method: 'get',
    path: '/api/events/stream',
    tags: ['Shrine'],
    summary: 'Server-Sent Events stream',
    description:
      'Supports `Last-Event-ID` for resume. Each frame carries the `shrine.system_events.sequence` as its id.',
    request: {
      query: z.object({
        last_event_id: z.string().optional(),
        project_id: z.string().uuid().optional(),
      }),
    },
    responses: { 200: { description: 'An event stream (text/event-stream).' } },
  });
  route({
    method: 'get',
    path: '/api/shrine/config',
    tags: ['Shrine'],
    summary: 'Sanitized operational configuration',
    description: 'Never contains credentials, full DSNs, session secrets or agent tokens.',
    responses: {
      200: { description: 'Configuration.', schema: z.object({ config: shrineConfigSchema }) },
    },
  });
  route({
    method: 'get',
    path: '/api/shrine/schema',
    tags: ['Shrine'],
    summary: 'Current and expected database schema versions',
    responses: {
      200: { description: 'Schema state.', schema: z.object({ schema: schemaVersionSchema }) },
    },
  });
  route({
    method: 'get',
    path: '/api/shrine/metrics-summary',
    tags: ['Shrine'],
    summary: 'Operational metrics summary',
    responses: {
      200: { description: 'Metrics.', schema: z.object({ metrics: metricsSummarySchema }) },
    },
  });
  route({
    method: 'get',
    path: '/api/shrine/audit',
    tags: ['Shrine'],
    summary: 'Administrative audit log',
    responses: {
      200: {
        description: 'Audit entries, newest first.',
        schema: z.object({
          items: z.array(auditLogSchema),
          next_cursor: z.string().nullable(),
          has_more: z.boolean(),
        }),
      },
    },
  });

  // --- routes that exist on the server and were missing from this document ---------------
  // A route reaching the server without a registration here is invisible to `openapi:check`,
  // which only diffs this generator against the committed JSON. `openapi.api.test.ts` walks
  // the live Fastify route table and fails if anything below falls out of step again.

  const listOf = (schema: z.ZodTypeAny) =>
    z.object({ items: z.array(schema), next_cursor: z.string().nullable(), has_more: z.boolean() });
  const questId = z.object({ questId: z.string().uuid() });
  const sessionId = z.object({ sessionId: z.string().uuid() });

  route({
    method: 'get',
    path: '/api/auth/device/pending',
    tags: ['Security'],
    summary: 'List device authorizations awaiting approval',
    responses: { 200: { description: 'Pending device codes.', schema: z.record(z.unknown()) } },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/tokens',
    tags: ['Security'],
    summary: 'List the agent tokens issued for a project',
    request: { params: projectRef },
    responses: {
      200: { description: 'Tokens.', schema: z.object({ items: z.array(agentTokenSchema) }) },
    },
  });
  route({
    method: 'get',
    path: '/api/lore/updates/{updateId}',
    tags: ['Lore'],
    summary: 'Read one Lore update',
    request: { params: z.object({ updateId: z.string().uuid() }) },
    responses: {
      200: { description: 'The update.', schema: z.object({ update: memoryUpdateSchema }) },
      404: { description: 'No such update.' },
    },
  });
  route({
    method: 'post',
    path: '/api/projects/{projectRef}/lore/updates',
    tags: ['Lore'],
    summary: 'Propose a Lore update (alias of remember)',
    request: { params: projectRef, body: rememberRequestSchema },
    responses: {
      201: { description: 'Created.', schema: z.object({ update: memoryUpdateSchema }) },
    },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/lore-updates',
    tags: ['Lore'],
    summary: 'List Lore updates',
    request: { params: projectRef },
    responses: { 200: { description: 'Updates.', schema: listOf(memoryUpdateSchema) } },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/lore-links',
    tags: ['Lore'],
    summary: 'List the relations between Lore Entries',
    request: { params: projectRef },
    responses: {
      200: { description: 'Relations.', schema: z.object({ items: z.array(memoryLinkSchema) }) },
    },
  });
  route({
    method: 'delete',
    path: '/api/lore-links/{linkId}',
    tags: ['Lore'],
    summary: 'Remove a relation',
    request: { params: z.object({ linkId: z.string().uuid() }) },
    responses: { 200: { description: 'Removed.', schema: z.object({ ok: z.boolean() }) } },
  });
  route({
    method: 'post',
    path: '/api/quests/{questId}/archive',
    tags: ['Quest'],
    summary: 'Archive a completed Quest',
    request: { params: questId },
    responses: { 200: { description: 'Archived.', schema: z.object({ quest: questSchema }) } },
  });
  route({
    method: 'delete',
    path: '/api/quests/{questId}/dependencies/{dependsOnId}',
    tags: ['Quest'],
    summary: 'Remove a Quest dependency',
    request: {
      params: z.object({ questId: z.string().uuid(), dependsOnId: z.string().uuid() }),
    },
    responses: { 200: { description: 'Removed.', schema: z.object({ ok: z.boolean() }) } },
  });
  route({
    method: 'get',
    path: '/api/quests/{questId}/checkpoints',
    tags: ['Quest'],
    summary: "List a Quest's checkpoints, newest first",
    request: { params: questId },
    responses: { 200: { description: 'Checkpoints.', schema: listOf(checkpointSchema) } },
  });
  route({
    method: 'get',
    path: '/api/quests/{questId}/plan',
    tags: ['Quest'],
    summary: "A Quest's numbered plan and its progress",
    request: { params: questId },
    responses: { 200: { description: 'Plan.', schema: questPlanSchema } },
  });
  route({
    method: 'put',
    path: '/api/quests/{questId}/plan',
    tags: ['Quest'],
    summary: "Declare or re-declare a Quest's plan",
    description:
      'Steps are numbered by position, from 1. A step keeps its recorded status when its ' +
      'position and title both survive the re-declaration; anything renamed, inserted or ' +
      'reordered starts pending. An empty array removes the plan. Settling the last step ' +
      'completes the Quest, on a project whose quest_completion_mode is auto.',
    request: { params: questId, body: setQuestPlanRequestSchema },
    responses: { 200: { description: 'Plan.', schema: questPlanSchema } },
  });
  route({
    method: 'get',
    path: '/api/quests/{questId}/sessions',
    tags: ['Quest'],
    summary: 'List the sessions that worked on a Quest',
    request: { params: questId },
    responses: {
      200: { description: 'Sessions.', schema: z.object({ items: z.array(sessionSchema) }) },
    },
  });
  route({
    method: 'get',
    path: '/api/sessions/{sessionId}',
    tags: ['Quest'],
    summary: 'Read a session',
    request: { params: sessionId },
    responses: {
      200: { description: 'The session.', schema: z.object({ session: sessionSchema }) },
      404: { description: 'No such session.' },
    },
  });
  route({
    method: 'post',
    path: '/api/sessions/{sessionId}/heartbeat',
    tags: ['Quest'],
    summary: 'Keep a session and its agent run alive',
    request: { params: sessionId },
    responses: { 200: { description: 'Renewed.', schema: z.record(z.unknown()) } },
  });
  route({
    method: 'post',
    path: '/api/party/runs/{runId}/end',
    tags: ['Party'],
    summary: 'End an agent run and release its claims',
    request: { params: z.object({ runId: z.string().uuid() }) },
    responses: { 200: { description: 'Ended.', schema: z.object({ agent_run: agentRunSchema }) } },
  });
  route({
    method: 'post',
    path: '/api/party/claims/{claimId}/renew',
    tags: ['Party'],
    summary: 'Renew a claim lease',
    request: { params: z.object({ claimId: z.string().uuid() }) },
    responses: {
      200: { description: 'Renewed.', schema: z.object({ claim: claimSchema }) },
      409: { description: 'The claim is no longer active.' },
    },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/party/runs',
    tags: ['Party'],
    summary: 'List agent runs',
    request: { params: projectRef },
    responses: {
      200: { description: 'Runs.', schema: z.object({ items: z.array(agentRunSchema) }) },
    },
  });
  route({
    method: 'get',
    path: '/api/projects/{projectRef}/party/claims',
    tags: ['Party'],
    summary: 'List claims, active or historical',
    request: { params: projectRef },
    responses: {
      200: { description: 'Claims.', schema: z.object({ items: z.array(claimSchema) }) },
    },
  });
  route({
    method: 'get',
    path: '/api/shrine/jobs/{jobId}',
    tags: ['Shrine'],
    summary: 'Read one job',
    request: { params: z.object({ jobId: z.string().uuid() }) },
    responses: {
      200: { description: 'The job.', schema: z.object({ job: jobSchema }) },
      404: { description: 'No such job.' },
    },
  });

  // Referenced for documentation completeness even where no route embeds them directly.
  registry.register('WorkState', workStateSchema);
  registry.register('Checkpoint', checkpointSchema);
  registry.register('Session', sessionSchema);

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Saga API',
      version,
      description: [
        'Saga — shared project memory, work continuity and coordination for coding agents.',
        '',
        '**Project identity is the project name.** Repository URL, branch, commit and remote are',
        'never accepted, stored or required: version control is a local-client concern only.',
        '',
        'Errors use one stable envelope with a machine-readable code and the request id.',
        'Retryable creates and mutations accept an `Idempotency-Key` header.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'Same origin as Guild Hall' }],
    tags: [
      { name: 'Projects', description: 'Project identity and aliases.' },
      { name: 'Lore', description: 'Durable project knowledge.' },
      { name: 'Quest', description: 'Work continuity: sessions, checkpoints and handoffs.' },
      { name: 'Party', description: 'Live agent coordination.' },
      { name: 'Shrine', description: 'Operations: health, jobs, events and configuration.' },
      { name: 'Security', description: 'Authentication and token management.' },
    ],
  }) as unknown as Record<string, unknown>;
}
