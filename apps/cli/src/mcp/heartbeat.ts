import type { SagaClient } from '@saga/agent-sdk';
import type { McpSession } from './server.js';

/**
 * Keep an MCP session's agent run and claims alive (spec 10, 14).
 *
 * A single tool call can run for minutes — an agent reads files, runs a test suite, waits for a
 * build. The agent-run lease is 90 seconds by default, so without an independent heartbeat the
 * run is reaped and its claims released while the agent still believes it holds them, and the
 * next agent is told the resource is free. Nothing in the MCP request/response cycle can do
 * this, because between tool calls no Saga code runs at all.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatOptions {
  intervalMs?: number;
  /** Injected in tests; defaults to the global timers. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onError?: (message: string) => void;
}

export class SessionHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly start_: typeof setInterval;
  private readonly stop_: typeof clearInterval;
  private readonly onError: (message: string) => void;

  constructor(
    private readonly client: SagaClient,
    private readonly session: McpSession,
    options: HeartbeatOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.start_ = options.setInterval ?? setInterval;
    this.stop_ = options.clearInterval ?? clearInterval;
    // stdout carries the MCP protocol, so a heartbeat problem can only go to stderr.
    this.onError = options.onError ?? ((message) => process.stderr.write(`${message}\n`));
  }

  start(): void {
    if (this.timer !== null) return;
    const timer = this.start_(() => void this.beat(), this.intervalMs);
    // The heartbeat must never be the reason the process stays alive; stdio decides that.
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer === null) return;
    this.stop_(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for an immediate beat after a long call is known to have started. */
  async beat(): Promise<void> {
    const { agentRunId, sessionId } = this.session;
    if (agentRunId === null && sessionId === null) {
      this.stop();
      return;
    }

    try {
      // Renewing claims alongside the run lease is the point: a claim outliving its holder is
      // what makes another agent wait on a resource nobody is using.
      if (agentRunId !== null) await this.client.partyHeartbeat(agentRunId, true);
      if (sessionId !== null) await this.client.sessionHeartbeat(sessionId);
    } catch (error) {
      this.onError(
        `saga-mcp: heartbeat failed (${error instanceof Error ? error.message : 'unknown'}). ` +
          'The agent run lease may lapse; claims could be released while you still hold them.',
      );
    }
  }
}
