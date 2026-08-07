import { SagaClient, RETRY_GUIDANCE } from '@saga/agent-sdk';
import type { StartSessionResponse } from '@saga/contracts';
import { SagaError, errorMessage, isSagaError } from '@saga/shared';
import { z } from 'zod';
import { detectWorkspace, findBinding, loadConfig, newIdempotencyKey } from '../workspace.js';
import { CredentialStore } from '../credentials.js';

/**
 * MCP tool surface (spec 14).
 *
 * The tools are deliberately shaped around the session lifecycle rather than around the HTTP
 * API: an agent should be able to follow the integration policy without knowing any URLs.
 */

export interface McpSession {
  sessionId: string | null;
  agentRunId: string | null;
  questId: string | null;
  questRevision: number;
  projectRef: string;
  client: string;
  /**
   * Whether the project still has no Core Context, as reported by the last `startSession`.
   *
   * Held on the session because `saga_activate_task` has to repeat the bootstrap prompt: by the
   * time an agent has read the code for its first task it is long past the `saga_start_session`
   * response, and a plan mentioned once at session open is a plan that never gets carried out.
   */
  bootstrapRequired: boolean;
  /**
   * The in-flight or settled `startSession` call, held so the session is opened once.
   *
   * A promise rather than the response, because `initialize` and the agent's own
   * `saga_start_session` can both reach `openSession` before either finishes; two checks of a
   * settled value would open two sessions for one agent. See `openSession`.
   */
  opening?: Promise<StartSessionResponse> | null;
}

/**
 * Keeps the agent-run lease alive between tool calls. Declared as a shape rather than imported,
 * so the tool surface does not depend on the timer implementation. See `heartbeat.ts`.
 */
export interface HeartbeatController {
  start(): void;
  stop(): void;
}

export interface McpToolContext {
  client: SagaClient;
  session: McpSession;
  workspace: { root: string; kind: string; workspaceKey: string; workspaceLabel: string };
  heartbeat?: HeartbeatController;
}

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler(args: Record<string, unknown>, context: McpToolContext): Promise<unknown>;
}

// --- schemas ---------------------------------------------------------------

const workStateSchema = z.object({
  goal: z.string().min(1),
  completed: z.array(z.string()).default([]),
  in_progress: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
  blockers: z
    .array(z.object({ description: z.string(), suggested_action: z.string().optional() }))
    .default([]),
  decisions: z.array(z.object({ decision: z.string(), reason: z.string().optional() })).default([]),
  changed_files: z
    .array(
      z.object({
        path: z.string(),
        base_hash: z.string().optional(),
        current_hash: z.string().optional(),
      }),
    )
    .default([]),
  commands: z
    .array(
      z.object({
        command: z.string(),
        status: z.enum(['succeeded', 'failed', 'skipped', 'running']).optional(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
  tests: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(['passed', 'failed', 'blocked', 'skipped', 'running']),
        summary: z.string().optional(),
      }),
    )
    .default([]),
});

const scopeSchema = z.object({
  modules: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  apis: z.array(z.string()).optional(),
  databases: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  issue_keys: z.array(z.string()).optional(),
});

// --- session ---------------------------------------------------------------

/**
 * The integration policy, carried in the MCP `initialize` result (spec 14).
 *
 * A tool description is only read when the agent is already looking for a tool to call, so it
 * cannot tell an agent to do something *before* it starts work. `instructions` is the one part
 * of the protocol a host puts in front of the model at the start of the session, which is where
 * this belongs. It repeats the policy in `docs/agent-integration.md` §2 deliberately: an agent
 * that only ever sees this string must still follow the whole lifecycle.
 */
export const MCP_INSTRUCTIONS =
  'This folder is bound to a Saga project — shared memory and work continuity across agents.\n' +
  'Before reading any file, call saga_start_session and read the Core Context it returns.\n' +
  'When it reports bootstrap_required, this project has no Lore yet and nothing else will ' +
  'create it: work through the bootstrap_plan it returns as you read the code for the first ' +
  'task, and record what you find with saga_remember before you stop.\n' +
  'On the first user task call saga_activate_task with the request verbatim, and read the ' +
  'returned Task and Continuation context before editing anything.\n' +
  'Call saga_checkpoint at every milestone and before context compaction. Claim shared ' +
  'resources with saga_claim_resource before risky operations. Record durable knowledge with ' +
  'saga_remember — never transient state, never credentials.\n' +
  'Call saga_end_session with a final handoff before you stop, so the next session can continue.';

/**
 * Open the session for this folder, at most once per process.
 *
 * Called both by `saga_start_session` and by the server itself as soon as a client finishes
 * `initialize`. A client attaching to this folder *is* an agent working in it, and leaving the
 * registration to the tool call makes Party presence depend on the model choosing to make it:
 * a folder that is bound, authorised and healthy then stays invisible in Guild Hall for the
 * whole session, with nothing in `saga doctor` to show for it.
 *
 * Idempotent because both callers run for every agent that follows its instructions. A failed
 * attempt clears the guard, so a later tool call can try again rather than inheriting a dead
 * session for the life of the process.
 */
export function openSession(ctx: McpToolContext, agent?: string): Promise<StartSessionResponse> {
  ctx.session.opening ??= startSession(ctx, agent).catch((error: unknown) => {
    ctx.session.opening = null;
    throw error;
  });
  return ctx.session.opening;
}

async function startSession(ctx: McpToolContext, agent?: string): Promise<StartSessionResponse> {
  const started = await ctx.client.startSession(
    {
      project: ctx.session.projectRef,
      client: ctx.session.client,
      agent,
      workspace_key: ctx.workspace.workspaceKey,
      workspace_label: ctx.workspace.workspaceLabel,
    },
    { idempotencyKey: newIdempotencyKey() },
  );

  ctx.session.sessionId = started.session_id;
  ctx.session.agentRunId = started.agent_run_id;
  ctx.session.bootstrapRequired = started.bootstrap_required;
  // From here a single tool call can outlast the lease, so the heartbeat runs on its own
  // timer rather than on the request cycle.
  ctx.heartbeat?.start();
  return started;
}

/** How long a shutdown waits for the server before letting the process go anyway. */
export const SHUTDOWN_END_TIMEOUT_MS = 2_000;

/**
 * End the session because the process is going away.
 *
 * A dying process is not a finished Quest, so nothing is declared here: no handoff and no
 * `quest_status`. It releases the agent run and its claims and leaves the Quest exactly as the
 * agent left it.
 *
 * Skipping this is not free. The session stays `active` until the abandon reaper runs hours
 * later; the next process opens a second session for the same folder; and a Quest with a
 * phantom session still attached refuses the completion a *later* agent legitimately declares
 * — the guard cannot tell an abandoned session from a colleague still working.
 *
 * Bounded, because an unreachable server must never be the reason a process will not exit.
 */
export async function closeSession(
  ctx: McpToolContext,
  timeoutMs = SHUTDOWN_END_TIMEOUT_MS,
): Promise<void> {
  ctx.heartbeat?.stop();
  const sessionId = ctx.session.sessionId;
  if (sessionId === null) return;

  ctx.session.sessionId = null;
  ctx.session.agentRunId = null;
  ctx.session.questId = null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ctx.client.endSession(sessionId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        // The timeout must not be what keeps the process alive.
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch (error) {
    // stdout carries the protocol, and the process is leaving either way: say so and go.
    process.stderr.write(`saga-mcp: could not end the session cleanly: ${errorMessage(error)}\n`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- tools -----------------------------------------------------------------

export const TOOLS: McpTool[] = [
  {
    name: 'saga_start_session',
    description:
      'Open a Saga session for this folder. Returns short Core Context and whether Lore bootstrap is required. Call this first, before reading any files. Safe to call once at the start of every session: the session is opened when your client connects, so this returns the one already open rather than a second. It does NOT attach a Quest and does NOT load any handoff — that happens in saga_activate_task once you know what the user wants.',
    inputSchema: z.object({
      agent: z.string().optional().describe('Agent name, e.g. "claude" or "codex".'),
    }),
    async handler(args, ctx) {
      // `agent` is ignored when the session is already open. The name the client reported at
      // `initialize` is the more reliable of the two anyway — it is not the model's guess.
      const started = await openSession(ctx, args.agent as string | undefined);

      return {
        session_id: started.session_id,
        state: started.state,
        project: started.project,
        project_revision: started.project_revision,
        core_context: started.core_context,
        bootstrap_required: started.bootstrap_required,
        bootstrap_plan: started.bootstrap_plan,
        open_quests: started.open_quests,
        // A bootstrap plan nobody is told to carry out is a plan that never runs: no worker job
        // and no other tool writes the first Lore Entry, so the project stays empty for every
        // session that follows. Say so here rather than leaving it to `bootstrap_plan` alone.
        next_step: started.bootstrap_required
          ? 'Wait for the first user task, then call saga_activate_task. Do not load a handoff before that. This project has no Core Context yet: as you read the code for that task, work through bootstrap_plan and record each entry with saga_remember before you stop.'
          : 'Wait for the first user task, then call saga_activate_task. Do not load a handoff before that.',
      };
    },
  },

  {
    name: 'saga_activate_task',
    description:
      'Report the first user task. Saga classifies it as new_work, resume_work or inquiry, creates or attaches a Quest, and returns Core, Task and (for resume_work) Continuation context. Read the returned context before editing any file.',
    inputSchema: z.object({
      task: z.string().min(1).describe('The user request, verbatim where possible.'),
      mode_hint: z.enum(['auto', 'new_work', 'resume_work', 'inquiry']).optional(),
      requested_quest_id: z.string().optional().describe('Set when the user names a Quest.'),
      scope: scopeSchema.optional().describe('Modules, files and APIs you expect to touch.'),
    }),
    async handler(args, ctx) {
      requireSession(ctx);
      const result = await ctx.client.activateSession(ctx.session.sessionId!, {
        task: args.task as string,
        mode_hint: args.mode_hint as never,
        requested_quest_id: (args.requested_quest_id as string | undefined) ?? null,
        scope: args.scope as never,
      });

      ctx.session.questId = result.quest?.id ?? null;
      ctx.session.questRevision = result.quest?.revision ?? 0;

      const bootstrap = ctx.session.bootstrapRequired
        ? ' This project still has no Core Context: record what you learn about it with saga_remember, following the bootstrap_plan from saga_start_session.'
        : '';

      return {
        activation_mode: result.activation_mode,
        quest: result.quest,
        context: result.context,
        related_quests: result.related_quests,
        next_step:
          (result.activation_mode === 'inquiry'
            ? 'No Quest was created. If this turns into real work, call saga_activate_task again with mode_hint "new_work".'
            : `Record checkpoints with saga_checkpoint using expected_quest_revision ${result.quest?.revision ?? 0}.`) +
          bootstrap,
      };
    },
  },

  {
    name: 'saga_get_context',
    description:
      'Refresh context for the current task: Core, Task, Continuation and Party layers, plus the project memory revision and any stale-Lore warnings. Call this when the project or parallel work has changed materially, or before a risky operation.',
    inputSchema: z.object({
      task: z.string().optional(),
      token_budget: z.number().int().min(500).max(60_000).optional(),
    }),
    async handler(args, ctx) {
      const context = await ctx.client.context(ctx.session.projectRef, {
        task: args.task as string | undefined,
        mode: ctx.session.questId === null ? 'inquiry' : 'resume_work',
        quest_id: ctx.session.questId ?? undefined,
        session_id: ctx.session.sessionId ?? undefined,
        token_budget: args.token_budget as number | undefined,
      });
      return context;
    },
  },

  {
    name: 'saga_search_lore',
    description:
      'Search this project’s durable knowledge. Returns Lore keys, concise content, relevance, verification state, freshness and evidence summaries. Prefer this over guessing, and over re-reading the whole repository.',
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      categories: z.array(z.string()).optional(),
      states: z.array(z.enum(['active', 'stale', 'archived'])).optional(),
      relation_depth: z.number().int().min(0).max(2).optional(),
    }),
    async handler(args, ctx) {
      return ctx.client.searchLore(ctx.session.projectRef, {
        query: args.query as string,
        limit: args.limit as number | undefined,
        relation_depth: args.relation_depth as number | undefined,
        filters: {
          categories: args.categories as never,
          states: (args.states as never) ?? undefined,
        },
      });
    },
  },

  {
    name: 'saga_checkpoint',
    description:
      'Record progress on the current Quest. Call at every milestone, before context compaction, when an important test finishes, before a risky operation, when work becomes blocked, and before the session ends. Requires the expected Quest revision: a mismatch returns a conflict with the latest revision, and you must re-read before retrying.',
    inputSchema: z.object({
      kind: z.enum(['automatic', 'milestone', 'final_handoff']).default('automatic'),
      summary: z.string().min(1),
      work_state: workStateSchema,
      expected_quest_revision: z
        .number()
        .int()
        .optional()
        .describe('Defaults to the revision this session last observed.'),
    }),
    async handler(args, ctx) {
      requireSession(ctx);
      if (ctx.session.questId === null) {
        throw new SagaError(
          'SESSION_STATE_INVALID',
          'This session has no Quest. Call saga_activate_task with mode_hint "new_work" before recording a checkpoint.',
        );
      }

      const expected =
        (args.expected_quest_revision as number | undefined) ?? ctx.session.questRevision;

      const result = await ctx.client.checkpoint(
        ctx.session.sessionId!,
        {
          expected_quest_revision: expected,
          kind: args.kind as never,
          summary: args.summary as string,
          work_state: args.work_state as never,
        },
        { idempotencyKey: newIdempotencyKey() },
      );

      ctx.session.questRevision = result.quest_revision;
      return {
        checkpoint_id: result.checkpoint.id,
        quest_revision: result.quest_revision,
        next_step: `Use expected_quest_revision ${result.quest_revision} for the next checkpoint.`,
      };
    },
  },

  {
    name: 'saga_remember',
    description:
      'Propose durable project knowledge as one or more Lore Entries. Use only for knowledge that stays true beyond this task — never for transient task state, and never for credentials. This creates a candidate; it never overwrites current Lore directly.',
    inputSchema: z.object({
      summary: z.string().min(1).describe('Why these entries are being recorded.'),
      entries: z
        .array(
          z.object({
            memory_key: z.string().describe('Lowercase dot-separated, e.g. run.api.local'),
            category: z.string(),
            kind: z.string(),
            body: z.string().min(1),
            data: z.record(z.unknown()).optional(),
            evidence: z
              .array(z.object({ path: z.string(), content_hash: z.string().optional() }))
              .optional(),
            confidence: z.number().min(0).max(1),
            verification_state: z.enum(['observed', 'inferred', 'verified']),
            importance: z.number().int().min(0).max(100).optional(),
            volatility: z.enum(['stable', 'operational']).optional(),
          }),
        )
        .min(1),
    }),
    async handler(args, ctx) {
      const result = await ctx.client.remember(
        ctx.session.projectRef,
        {
          summary: args.summary as string,
          entries: args.entries as never,
          session_id: ctx.session.sessionId ?? undefined,
        },
        { idempotencyKey: newIdempotencyKey() },
      );
      return {
        update_id: result.update.id,
        state: result.update.state,
        approval_mode: result.approval_mode,
        message: result.message,
      };
    },
  },

  {
    name: 'saga_claim_resource',
    description:
      'Claim a resource before a risky or exclusive operation: a migration sequence, a test database reset, a deployment, a service restart or production configuration. On conflict you receive the owning Quest and its lease expiry — do NOT proceed without the claim.',
    inputSchema: z.object({
      resource_type: z.enum([
        'module',
        'file',
        'database_schema',
        'migration_sequence',
        'environment',
        'service',
        'deployment',
        'test_environment',
        'service_restart',
        'production_config',
      ]),
      resource_key: z.string().min(1),
      mode: z.enum(['shared', 'exclusive']).default('exclusive'),
      base_fingerprint: z.string().optional(),
    }),
    async handler(args, ctx) {
      requireSession(ctx);
      if (ctx.session.agentRunId === null) {
        throw new SagaError(
          'PARTY_DISABLED',
          'No agent run is active for this session, so claims are unavailable. Coordination may be disabled on this server.',
        );
      }
      if (ctx.session.questId === null) {
        throw new SagaError(
          'SESSION_STATE_INVALID',
          'A claim belongs to a Quest. Call saga_activate_task first.',
        );
      }

      const result = await ctx.client.claim({
        agent_run_id: ctx.session.agentRunId,
        work_item_id: ctx.session.questId,
        resource_type: args.resource_type as never,
        resource_key: args.resource_key as string,
        mode: args.mode as never,
        base_fingerprint: (args.base_fingerprint as string | undefined) ?? null,
      });
      return { claim: result.claim, warnings: result.warnings };
    },
  },

  {
    name: 'saga_release_claim',
    description:
      'Release a claim you hold, as soon as the protected operation finishes. Idempotent: releasing an already released claim is not an error.',
    inputSchema: z.object({
      claim_id: z.string().min(1),
      reason: z.string().optional(),
    }),
    async handler(args, ctx) {
      if (ctx.session.agentRunId === null) {
        throw new SagaError('PARTY_DISABLED', 'No agent run is active for this session.');
      }
      const result = await ctx.client.releaseClaim(
        args.claim_id as string,
        ctx.session.agentRunId,
        args.reason as string | undefined,
      );
      return { claim: result.claim };
    },
  },

  {
    name: 'saga_end_session',
    description:
      'End the session cleanly: record a final handoff for the Quest, end the durable session, end the agent run and release its claims. Always call this before you stop, so the next session can continue from where you left off. Set quest_status to say what became of the Quest — nothing infers it, so a Quest you leave unmentioned stays open for whoever picks it up next.',
    inputSchema: z.object({
      summary: z.string().optional().describe('Required when a Quest is attached.'),
      work_state: workStateSchema.optional(),
      quest_status: z
        .enum(['completed', 'blocked', 'waiting', 'cancelled'])
        .optional()
        .describe(
          'What became of the Quest. Set "completed" only when the work itself is done, not merely when you are stopping — a completed Quest cannot be resumed and no tool can reopen it. Omit it to leave the Quest open. The project may require a person to confirm a completion, in which case the reply says so in quest_status_held.',
        ),
    }),
    async handler(args, ctx) {
      requireSession(ctx);

      const hasQuest = ctx.session.questId !== null;
      if (hasQuest && (args.summary === undefined || args.work_state === undefined)) {
        throw new SagaError(
          'CHECKPOINT_INVALID',
          'This session owns a Quest, so a final handoff is required. Supply summary and work_state describing what is done, what is in progress, blockers and next steps.',
        );
      }

      const result = await ctx.client.endSession(ctx.session.sessionId!, {
        handoff: hasQuest
          ? {
              expected_quest_revision: ctx.session.questRevision,
              summary: args.summary as string,
              work_state: args.work_state as never,
            }
          : undefined,
        quest_status: args.quest_status as never,
      });

      ctx.heartbeat?.stop();
      ctx.session.sessionId = null;
      ctx.session.agentRunId = null;
      ctx.session.questId = null;
      // Clearing the guard too, so an agent that carries on working after ending its session
      // opens a new one rather than talking to a session the server has already closed.
      ctx.session.opening = null;

      return {
        session_state: result.session.state,
        handoff_id: result.handoff?.id ?? null,
        quest_revision: result.quest_revision,
        released_claims: result.released_claims,
        quest_status: result.quest_status,
        quest_status_held: result.quest_status_held,
      };
    },
  },
];

function requireSession(ctx: McpToolContext): void {
  if (ctx.session.sessionId === null) {
    throw new SagaError(
      'SESSION_NOT_FOUND',
      'No Saga session is open. Call saga_start_session first.',
    );
  }
}

/** Turn any failure into a result an agent can act on rather than a stack trace. */
export function toToolError(error: unknown): McpToolResult {
  if (isSagaError(error)) {
    const guidance = RETRY_GUIDANCE[error.code];
    const body = {
      error: error.code,
      message: error.message,
      details: error.details,
      what_to_do:
        guidance ??
        (error.retryable
          ? 'This looks transient. Retrying shortly is safe.'
          : 'Fix the request before retrying.'),
    };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: 'INTERNAL_ERROR',
            message: errorMessage(error),
            what_to_do: 'Retry once; if it persists, run `saga doctor`.',
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

export interface BuildContextResult {
  context: McpToolContext;
  problems: string[];
}

/** Resolve the project binding, credentials and workspace for this folder. */
export async function buildToolContext(clientName: string): Promise<BuildContextResult> {
  const problems: string[] = [];
  const workspace = detectWorkspace();
  const config = loadConfig();
  const binding = findBinding(config, workspace.root);

  const serverUrl =
    process.env.SAGA_SERVER_URL ??
    binding?.serverUrl ??
    config.serverUrl ??
    'http://localhost:4319';
  const projectRef = process.env.SAGA_PROJECT ?? binding?.projectId ?? null;

  if (projectRef === null) {
    problems.push(
      'This folder is not bound to a Saga project. Run `saga connect` in the project root.',
    );
  }

  const token = await new CredentialStore().get(serverUrl);
  if (token === null) {
    problems.push(`No credentials stored for ${serverUrl}. Run \`saga connect\`.`);
  }

  return {
    context: {
      client: new SagaClient({
        baseUrl: serverUrl,
        token: token ?? '',
        client: clientName,
      }),
      session: {
        sessionId: null,
        agentRunId: null,
        questId: null,
        questRevision: 0,
        projectRef: projectRef ?? '',
        client: clientName,
        bootstrapRequired: false,
      },
      workspace: {
        root: workspace.root,
        kind: workspace.kind,
        workspaceKey: workspace.workspaceKey,
        workspaceLabel: workspace.workspaceLabel,
      },
    },
    problems,
  };
}
