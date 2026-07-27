import { SagaError } from '@saga/shared';
import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from './json-schema.js';
import { TOOLS, toToolError, type McpToolContext } from './server.js';

const REQUIRED_TOOLS = [
  'saga_start_session',
  'saga_activate_task',
  'saga_get_context',
  'saga_search_lore',
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
