import { SagaError } from '@saga/shared';
import { describe, expect, it } from 'vitest';
import { MCP_INSTRUCTIONS } from '../agent-instructions.js';
import { zodToJsonSchema } from './json-schema.js';
import { TOOLS, closeSession, openSession, toToolError, type McpToolContext } from './server.js';

const REQUIRED_TOOLS = [
  'saga_start_session',
  'saga_activate_task',
  'saga_get_context',
  'saga_search_lore',
  'saga_plan_quest',
  'saga_reopen_quest',
  'saga_checkpoint',
  'saga_remember',
  'saga_claim_resource',
  'saga_release_claim',
  'saga_end_session',
];

function context(overrides: Partial<McpToolContext['session']> = {}): McpToolContext {
  return {
    client: {} as McpToolContext['client'],
    session: {
      sessionId: null,
      agentRunId: null,
      questId: null,
      questRevision: 0,
      projectRef: 'project-1',
      client: 'test',
      bootstrapRequired: false,
      ...overrides,
    },
    workspace: {
      root: '/tmp/project',
      kind: 'plain',
      workspaceKey: 'k',
      workspaceLabel: 'machine:project',
    },
  };
}

describe('tool surface', () => {
  it('exposes exactly the tools the specification requires', () => {
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([...REQUIRED_TOOLS].sort());
  });

  it('gives every tool a description that says when to call it', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(60);
    }
  });

  it('tells the agent not to load a handoff at session start', () => {
    const start = TOOLS.find((tool) => tool.name === 'saga_start_session')!;
    expect(start.description).toMatch(/does NOT attach a Quest/);
    expect(start.description).toMatch(/does NOT load any handoff/);
  });

  it('tells the agent when to checkpoint', () => {
    const checkpoint = TOOLS.find((tool) => tool.name === 'saga_checkpoint')!;
    expect(checkpoint.description).toMatch(/milestone/);
    expect(checkpoint.description).toMatch(/compaction/);
    expect(checkpoint.description).toMatch(/before the session ends/);
  });

  it('tells the agent not to proceed on a claim conflict', () => {
    const claim = TOOLS.find((tool) => tool.name === 'saga_claim_resource')!;
    expect(claim.description).toMatch(/do NOT proceed without the claim/i);
  });

  it('warns that ending a session does not close the Quest by itself', () => {
    const end = TOOLS.find((tool) => tool.name === 'saga_end_session')!;
    const schema = zodToJsonSchema(end.inputSchema) as {
      properties: { quest_status: { enum: string[]; description: string } };
    };

    expect(schema.properties.quest_status.enum).toContain('completed');
    // An agent that stops is not an agent that finished. Saying so in the description is the
    // only place the distinction reaches the model before it picks a value.
    expect(schema.properties.quest_status.description).toMatch(/not merely when you are stopping/);
    expect(schema.properties.quest_status.description).toMatch(/cannot be resumed/);
  });

  it('sends the declared Quest status and reports what the server did with it', async () => {
    const end = TOOLS.find((tool) => tool.name === 'saga_end_session')!;
    let sent: Record<string, unknown> = {};
    const ctx = context({ sessionId: 'session-1', questId: 'quest-1', questRevision: 4 });
    ctx.client = {
      endSession: async (_id: string, input: Record<string, unknown>) => {
        sent = input;
        return {
          session: { state: 'completed' },
          handoff: { id: 'checkpoint-1' },
          quest_revision: 5,
          released_claims: 0,
          quest_status: 'in_progress',
          quest_status_held: 'The project is on quest_completion_mode "manual".',
        };
      },
    } as unknown as McpToolContext['client'];

    const result = (await end.handler(
      { summary: 'done', work_state: { goal: 'g' }, quest_status: 'completed' },
      ctx,
    )) as { quest_status: string; quest_status_held: string };

    expect(sent.quest_status).toBe('completed');
    // The hold is the whole point of surfacing it: an agent told "completed" that reads back
    // `in_progress` has to know a person still has to confirm, not retry.
    expect(result.quest_status).toBe('in_progress');
    expect(result.quest_status_held).toMatch(/manual/);
  });

  it('warns that remember is for durable knowledge only', () => {
    const remember = TOOLS.find((tool) => tool.name === 'saga_remember')!;
    expect(remember.description).toMatch(/never for credentials/i);
    expect(remember.description).toMatch(/never for transient task state/i);
  });
});

describe('tool schemas', () => {
  it('converts every input schema to an object JSON Schema', () => {
    for (const tool of TOOLS) {
      const schema = zodToJsonSchema(tool.inputSchema);
      expect(schema.type, tool.name).toBe('object');
      expect(schema.properties, tool.name).toBeDefined();
    }
  });

  it('marks required fields', () => {
    const checkpoint = TOOLS.find((tool) => tool.name === 'saga_checkpoint')!;
    const schema = zodToJsonSchema(checkpoint.inputSchema);
    expect(schema.required).toContain('summary');
    expect(schema.required).toContain('work_state');
    // `expected_quest_revision` is optional: the server tracks the revision for the agent.
    expect(schema.required).not.toContain('expected_quest_revision');
  });

  it('carries the bounds of a number, so the model knows what scale it is answering on', () => {
    // The failure this replaces: `importance` reached the model as a bare `{"type":"integer"}`,
    // so agents assumed 1-5 on a field scored 0-100. That is inside the range, so nothing
    // rejected it — the entry was simply filed below everything already recorded, and the only
    // symptom was that it stopped appearing in Core Context.
    const remember = TOOLS.find((tool) => tool.name === 'saga_remember')!;
    const schema = zodToJsonSchema(remember.inputSchema) as {
      properties: {
        entries: {
          items: {
            properties: Record<
              string,
              { minimum?: number; maximum?: number; description?: string }
            >;
          };
        };
      };
    };
    const entry = schema.properties.entries.items.properties;

    expect(entry.importance).toMatchObject({ minimum: 0, maximum: 100 });
    expect(entry.importance?.description).toMatch(/0 to 100/);
    // `confidence` is the other scale on this tool and runs 0-1, which is exactly the confusion
    // worth ruling out: two numbers on one entry, neither of which announced its range.
    expect(entry.confidence).toMatchObject({ minimum: 0, maximum: 1 });
  });

  it('keeps the description on an optional field, which is where most of them are', () => {
    // Unwrapping ZodOptional without re-applying the wrapper's description dropped the hint on
    // every optional argument — the model saw a bare type and no reason to fill it in.
    const activate = TOOLS.find((tool) => tool.name === 'saga_activate_task')!;
    const schema = zodToJsonSchema(activate.inputSchema) as {
      properties: Record<string, { description?: string }>;
    };

    expect(schema.properties.requested_quest_id?.description).toMatch(/user names a Quest/);
    expect(schema.properties.scope?.description).toMatch(/expect to touch/);
    // The required field alongside them must keep working the way it always did.
    expect(schema.properties.task?.description).toMatch(/verbatim/);
  });

  it('describes the work-state structure the specification documents', () => {
    const checkpoint = TOOLS.find((tool) => tool.name === 'saga_checkpoint')!;
    const schema = zodToJsonSchema(checkpoint.inputSchema) as {
      properties: { work_state: { properties: Record<string, unknown> } };
    };
    for (const field of [
      'goal',
      'completed',
      'in_progress',
      'next_steps',
      'blockers',
      'decisions',
      'changed_files',
      'commands',
      'tests',
    ]) {
      expect(Object.keys(schema.properties.work_state.properties)).toContain(field);
    }
  });

  it('carries enum options through', () => {
    const claim = TOOLS.find((tool) => tool.name === 'saga_claim_resource')!;
    const schema = zodToJsonSchema(claim.inputSchema) as {
      properties: { resource_type: { enum: string[] } };
    };
    expect(schema.properties.resource_type.enum).toContain('migration_sequence');
    expect(schema.properties.resource_type.enum).toContain('production_config');
  });

  it('rejects arguments that do not match the schema', () => {
    const checkpoint = TOOLS.find((tool) => tool.name === 'saga_checkpoint')!;
    expect(checkpoint.inputSchema.safeParse({}).success).toBe(false);
    expect(
      checkpoint.inputSchema.safeParse({
        summary: 'x',
        work_state: { goal: 'g' },
      }).success,
    ).toBe(true);
  });
});

describe('session guards', () => {
  it('refuses to activate before a session is open', async () => {
    const activate = TOOLS.find((tool) => tool.name === 'saga_activate_task')!;
    await expect(activate.handler({ task: 'x' }, context())).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('refuses to checkpoint without a Quest', async () => {
    const checkpoint = TOOLS.find((tool) => tool.name === 'saga_checkpoint')!;
    await expect(
      checkpoint.handler(
        { kind: 'automatic', summary: 's', work_state: { goal: 'g' } },
        context({ sessionId: 'session-1' }),
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_INVALID' });
  });

  it('refuses to claim when coordination is unavailable', async () => {
    const claim = TOOLS.find((tool) => tool.name === 'saga_claim_resource')!;
    await expect(
      claim.handler(
        { resource_type: 'migration_sequence', resource_key: 'db', mode: 'exclusive' },
        context({ sessionId: 'session-1', agentRunId: null }),
      ),
    ).rejects.toMatchObject({ code: 'PARTY_DISABLED' });
  });

  it('requires a handoff when ending a session that owns a Quest', async () => {
    const end = TOOLS.find((tool) => tool.name === 'saga_end_session')!;
    await expect(
      end.handler({}, context({ sessionId: 'session-1', questId: 'quest-1' })),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_INVALID' });
  });
});

describe('error rendering', () => {
  it('turns a conflict into actionable guidance rather than a stack trace', () => {
    const result = toToolError(
      new SagaError('QUEST_REVISION_CONFLICT', 'The Quest changed.', {
        details: { latest_revision: 7 },
      }),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(body.error).toBe('QUEST_REVISION_CONFLICT');
    expect(body.details).toEqual({ latest_revision: 7 });
    expect(String(body.what_to_do)).toMatch(/Re-read the Quest/);
    expect(String(body.what_to_do)).toMatch(/Do not retry blindly/);
  });

  it('explains a claim conflict without telling the agent to retry', () => {
    const result = toToolError(
      new SagaError('RESOURCE_CLAIM_CONFLICT', 'Already claimed.', { details: {} }),
    );
    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(String(body.what_to_do)).toMatch(/Do not proceed without the claim/);
  });

  it('marks an unknown failure as retryable once', () => {
    const result = toToolError(new Error('socket hang up'));
    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(String(body.what_to_do)).toMatch(/saga doctor/);
  });

  it('never leaks a stack trace', () => {
    const error = new Error('boom');
    const result = toToolError(error);
    expect(result.content[0]!.text).not.toContain('at ');
  });
});

describe('server instructions', () => {
  // A host shows `instructions` to the model before it starts work, which is the only place the
  // policy can reach an agent that has not yet decided to call a tool.
  it('carries the whole session lifecycle', () => {
    for (const tool of [
      'saga_start_session',
      'saga_activate_task',
      'saga_checkpoint',
      'saga_remember',
      'saga_end_session',
    ]) {
      expect(MCP_INSTRUCTIONS).toContain(tool);
    }
  });

  it('says when to call the first two, not just that they exist', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/[Bb]efore reading any file/);
    expect(MCP_INSTRUCTIONS).toMatch(/before editing anything/);
  });

  it('repeats the limits on what may be remembered', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/never credentials/);
  });

  it('says what to do about a project that has no Lore yet', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/bootstrap_required/);
    expect(MCP_INSTRUCTIONS).toMatch(/bootstrap_plan/);
  });

  // "At every milestone" is a judgement the agent makes, and an agent deep in one long step
  // decides it has not reached one — so the Quest stops moving in Guild Hall while the agent is
  // still alive. A wall-clock bound is the part that does not depend on that judgement.
  it('asks for a checkpoint at milestones, not on a timer', () => {
    // The policy used to demand one every ten minutes, purely so Guild Hall could tell a
    // working agent from a dead one. The MCP server now reports each tool call on the
    // heartbeat, so that question is answered without the agent stopping to compose anything —
    // and a timer rule that outlived its reason would just be interruption for its own sake.
    expect(MCP_INSTRUCTIONS).not.toMatch(/every 10 minutes/);
    expect(MCP_INSTRUCTIONS).toMatch(/milestone/);
    expect(MCP_INSTRUCTIONS).toMatch(/background/);
    expect(MCP_INSTRUCTIONS).toMatch(/in_progress/);
  });
});

describe('opening the session', () => {
  function response(sessionId: string) {
    return {
      session_id: sessionId,
      state: 'awaiting_task',
      project: { id: 'project-1', name: 'Project' },
      project_revision: 0,
      core_context: 'core',
      bootstrap_required: false,
      bootstrap_plan: null,
      open_quests: [],
      agent_run_id: `run-${sessionId}`,
    };
  }

  /** A context whose client records every `startSession`, and a heartbeat that records starts. */
  function opening(startSession: (input: unknown) => Promise<unknown>) {
    const ctx = context();
    let started = 0;
    ctx.client = {
      startSession: async (input: unknown) => startSession(input),
    } as unknown as McpToolContext['client'];
    ctx.heartbeat = {
      start: () => {
        started += 1;
      },
      stop: () => undefined,
    };
    return { ctx, heartbeats: () => started };
  }

  it('opens one session when initialize and the agent both ask', async () => {
    let calls = 0;
    const { ctx } = opening(async () => {
      calls += 1;
      // Resolving on a later tick is the case the guard exists for: a settled-value check would
      // let the second caller through while the first request is still in flight.
      await Promise.resolve();
      return response('session-1');
    });

    const [first, second] = await Promise.all([openSession(ctx, 'claude'), openSession(ctx)]);

    expect(calls).toBe(1);
    expect(first.session_id).toBe('session-1');
    expect(second.session_id).toBe('session-1');
  });

  it('records the session and its agent run, and starts the heartbeat', async () => {
    const { ctx, heartbeats } = opening(async () => response('session-1'));

    await openSession(ctx, 'claude');

    expect(ctx.session.sessionId).toBe('session-1');
    expect(ctx.session.agentRunId).toBe('run-session-1');
    expect(heartbeats()).toBe(1);
  });

  it('reports the workspace, so Party can tell two checkouts apart', async () => {
    let seen: Record<string, unknown> = {};
    const { ctx } = opening(async (input) => {
      seen = input as Record<string, unknown>;
      return response('session-1');
    });

    await openSession(ctx, 'claude');

    expect(seen.workspace_key).toBe('k');
    expect(seen.workspace_label).toBe('machine:project');
    expect(seen.agent).toBe('claude');
  });

  it('lets a later caller retry after a failure', async () => {
    let calls = 0;
    const { ctx } = opening(async () => {
      calls += 1;
      if (calls === 1) throw new SagaError('INTERNAL_ERROR', 'the server was restarting');
      return response('session-2');
    });

    await expect(openSession(ctx)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    // A poisoned guard would leave the folder without a session for the life of the process.
    await expect(openSession(ctx)).resolves.toMatchObject({ session_id: 'session-2' });
    expect(calls).toBe(2);
  });

  it('returns the open session from saga_start_session rather than a second one', async () => {
    let calls = 0;
    const { ctx } = opening(async () => {
      calls += 1;
      return response('session-1');
    });
    const start = TOOLS.find((tool) => tool.name === 'saga_start_session')!;

    await openSession(ctx, 'claude');
    const result = (await start.handler({ agent: 'claude' }, ctx)) as { session_id: string };

    expect(calls).toBe(1);
    expect(result.session_id).toBe('session-1');
  });
});

/**
 * Nothing on the server writes the first Lore Entry: no worker job, no other tool. A plan the
 * agent is never told to carry out leaves the project empty for every session that follows it,
 * with `bootstrap_required` still true and every check reporting healthy.
 */
describe('bootstrapping a project with no Lore', () => {
  const start = TOOLS.find((tool) => tool.name === 'saga_start_session')!;
  const activate = TOOLS.find((tool) => tool.name === 'saga_activate_task')!;

  function toolContext(bootstrapRequired: boolean): McpToolContext {
    const ctx = context();
    ctx.client = {
      startSession: async () => ({
        session_id: 'session-1',
        state: 'awaiting_task',
        project: { id: 'project-1', name: 'Project' },
        project_revision: 0,
        core_context: bootstrapRequired ? '' : 'core',
        bootstrap_required: bootstrapRequired,
        bootstrap_plan: bootstrapRequired ? { required: true, proposed_keys: [] } : null,
        open_quests: [],
        agent_run_id: 'run-1',
      }),
      activateSession: async () => ({
        activation_mode: 'new_work',
        quest: { id: 'quest-1', revision: 0 },
        context: { core: '', task: '', continuation: null, party: null, warnings: [] },
        related_quests: [],
      }),
    } as unknown as McpToolContext['client'];
    return ctx;
  }

  it('tells the agent to carry the plan out, not merely that one exists', async () => {
    const result = (await start.handler({}, toolContext(true))) as { next_step: string };

    expect(result.next_step).toMatch(/bootstrap_plan/);
    expect(result.next_step).toMatch(/saga_remember/);
  });

  it('leaves the next step alone for a project that already has Core Context', async () => {
    const result = (await start.handler({}, toolContext(false))) as { next_step: string };

    expect(result.next_step).not.toMatch(/saga_remember/);
  });

  it('repeats the prompt on activation, when the agent is about to read the code', async () => {
    const ctx = toolContext(true);
    await start.handler({}, ctx);

    const activated = (await activate.handler({ task: 'add a route' }, ctx)) as {
      next_step: string;
    };

    // By the time the first task is understood the session response is far behind: a prompt made
    // once at session open is the one the agent has already scrolled past.
    expect(activated.next_step).toMatch(/saga_remember/);
  });

  it('says nothing about bootstrap once the project has Lore', async () => {
    const ctx = toolContext(false);
    await start.handler({}, ctx);

    const activated = (await activate.handler({ task: 'add a route' }, ctx)) as {
      next_step: string;
    };

    expect(activated.next_step).not.toMatch(/saga_remember/);
  });
});

describe('ending the session when the process goes away', () => {
  function shutdownContext(sessionId: string | null) {
    const calls: { sessionId: string; input: unknown }[] = [];
    let stopped = 0;
    const ctx = context({ sessionId, agentRunId: 'run-1', questId: 'quest-1' });
    ctx.client = {
      endSession: async (id: string, input: unknown) => {
        calls.push({ sessionId: id, input });
        return {};
      },
    } as unknown as McpToolContext['client'];
    ctx.heartbeat = {
      start: () => {},
      stop: () => {
        stopped += 1;
      },
    };
    return { ctx, calls, stopped: () => stopped };
  }

  it('ends the session and stops the heartbeat', async () => {
    const { ctx, calls, stopped } = shutdownContext('session-1');
    await closeSession(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sessionId).toBe('session-1');
    expect(stopped()).toBe(1);
    expect(ctx.session.sessionId).toBeNull();
    expect(ctx.session.agentRunId).toBeNull();
  });

  it('declares nothing about the Quest — a dying process is not a finished Quest', async () => {
    const { ctx, calls } = shutdownContext('session-1');
    await closeSession(ctx);

    // No handoff and no status: only `saga_end_session` may say what became of the work.
    expect(calls[0]!.input).toBeUndefined();
  });

  it('does nothing when no session was ever opened', async () => {
    const { ctx, calls, stopped } = shutdownContext(null);
    await closeSession(ctx);

    expect(calls).toEqual([]);
    // The heartbeat is still stopped: it may have been started and left running.
    expect(stopped()).toBe(1);
  });

  it('ends the session only once, however many times shutdown is triggered', async () => {
    const { ctx, calls } = shutdownContext('session-1');
    await closeSession(ctx);
    await closeSession(ctx);

    expect(calls).toHaveLength(1);
  });

  it('gives up rather than keeping the process alive when the server does not answer', async () => {
    const ctx = context({ sessionId: 'session-1' });
    ctx.client = {
      endSession: () => new Promise(() => {}),
    } as unknown as McpToolContext['client'];

    // Resolves rather than hanging: an unreachable server must not block the exit.
    await expect(closeSession(ctx, 10)).resolves.toBeUndefined();
  });
});
