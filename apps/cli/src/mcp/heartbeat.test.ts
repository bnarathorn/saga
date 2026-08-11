import type { SagaClient } from '@saga/agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { SessionHeartbeat } from './heartbeat.js';
import type { McpSession } from './server.js';

function session(overrides: Partial<McpSession> = {}): McpSession {
  return {
    sessionId: 'session-1',
    agentRunId: 'run-1',
    questId: 'quest-1',
    questRevision: 3,
    projectRef: 'project-1',
    client: 'saga-mcp',
    ...overrides,
  };
}

function fakeClient() {
  return {
    partyHeartbeat: vi.fn(async () => ({}) as never),
    sessionHeartbeat: vi.fn(async () => ({ ok: true as const })),
  };
}

describe('MCP session heartbeat', () => {
  it('renews the agent-run lease and its claims together', async () => {
    const client = fakeClient();
    const beat = new SessionHeartbeat(client as unknown as SagaClient, session());

    await beat.beat();

    // Renewing claims alongside the run is the point: a claim outliving its holder blocks
    // another agent on a resource nobody is using.
    expect(client.partyHeartbeat).toHaveBeenCalledWith('run-1', true, null);
    expect(client.sessionHeartbeat).toHaveBeenCalledWith('session-1');
  });

  it('reports the tool the agent called, then stops reporting it', async () => {
    // This is the whole background-progress signal: the agent composes nothing, the MCP server
    // observes a dispatch and the timer carries it. Reporting it once is what makes an ageing
    // `last_activity_at` mean silence — repeat it and an idle run looks busy for ever, which is
    // the failure `heartbeat_at` already has.
    const client = fakeClient();
    const beat = new SessionHeartbeat(client as unknown as SagaClient, session());

    beat.noteActivity('saga_search_lore');
    await beat.beat();
    await beat.beat();

    expect(client.partyHeartbeat).toHaveBeenNthCalledWith(1, 'run-1', true, 'saga_search_lore');
    expect(client.partyHeartbeat).toHaveBeenNthCalledWith(2, 'run-1', true, null);
  });

  it('does not resurrect an old tool call after a failed beat', async () => {
    // A retry that replayed it would date the activity to the retry, not to the call, and a
    // wrong timestamp here is worse than a missing one: it claims work that did not happen.
    const client = fakeClient();
    client.partyHeartbeat.mockRejectedValueOnce(new Error('connection reset'));
    const beat = new SessionHeartbeat(client as unknown as SagaClient, session(), {
      onError: () => {},
    });

    beat.noteActivity('saga_checkpoint');
    await beat.beat();
    await beat.beat();

    expect(client.partyHeartbeat).toHaveBeenNthCalledWith(2, 'run-1', true, null);
  });

  it('beats on its own timer, because no Saga code runs between tool calls', () => {
    const client = fakeClient();
    let tick: (() => void) | null = null;
    const beat = new SessionHeartbeat(client as unknown as SagaClient, session(), {
      intervalMs: 1_000,
      setInterval: ((handler: () => void) => {
        tick = handler;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        tick = null;
      }) as unknown as typeof clearInterval,
    });

    beat.start();
    expect(tick).not.toBeNull();
    tick!();
    expect(client.partyHeartbeat).toHaveBeenCalledTimes(1);

    beat.stop();
    expect(tick).toBeNull();
  });

  it('starts only one timer however often start is called', () => {
    const client = fakeClient();
    const setIntervalSpy = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const beat = new SessionHeartbeat(client as unknown as SagaClient, session(), {
      setInterval: setIntervalSpy as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    });

    beat.start();
    beat.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('stops itself once the session has ended', async () => {
    const client = fakeClient();
    const state = session({ sessionId: null, agentRunId: null });
    const clearSpy = vi.fn();
    const beat = new SessionHeartbeat(client as unknown as SagaClient, state, {
      setInterval: (() => 1 as unknown as ReturnType<typeof setInterval>) as never,
      clearInterval: clearSpy as never,
    });

    beat.start();
    await beat.beat();

    expect(client.partyHeartbeat).not.toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('still beats the session when coordination is disabled and there is no agent run', async () => {
    const client = fakeClient();
    const beat = new SessionHeartbeat(
      client as unknown as SagaClient,
      session({ agentRunId: null }),
    );

    await beat.beat();

    expect(client.partyHeartbeat).not.toHaveBeenCalled();
    expect(client.sessionHeartbeat).toHaveBeenCalledWith('session-1');
  });

  it('reports a failed beat without throwing into the tool call', async () => {
    const client = fakeClient();
    client.partyHeartbeat.mockRejectedValueOnce(new Error('network down') as never);
    const errors: string[] = [];
    const beat = new SessionHeartbeat(client as unknown as SagaClient, session(), {
      onError: (message) => errors.push(message),
    });

    await expect(beat.beat()).resolves.toBeUndefined();
    expect(errors[0]).toContain('network down');
    expect(errors[0]).toContain('claims could be released');
  });
});
