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
  /**
   * The tool called since the last beat, or `null` when nothing has happened.
   *
   * Reported once and then cleared, so `last_activity_at` on the server only moves when the
   * agent actually did something. A beat that reported the previous call again would make an
   * idle run indistinguishable from a busy one — which is the state this whole signal exists
   * to separate, and exactly what `heartbeat_at` already fails to do.
   */
  private pendingActivity: string | null = null;
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

  /**
   * Record that the agent just called a tool, to be reported on the next beat.
   *
   * Deliberately not a request of its own. The agent is mid-call when this runs, and spending
   * a round trip on saying so would add latency to the very thing it is reporting; the timer is
   * already going to the server within 30 seconds anyway.
   */
  noteActivity(tool: string): void {
    this.pendingActivity = tool;
  }

  /** Exposed for tests and for an immediate beat after a long call is known to have started. */
  async beat(): Promise<void> {
    const { agentRunId, sessionId } = this.session;
    if (agentRunId === null && sessionId === null) {
      this.stop();
      return;
    }

    // Taken before the request and not restored on failure: a retry would report an old call as
    // though it had just happened, and a stale activity time is worse than a missing one.
    const activity = this.pendingActivity;
    this.pendingActivity = null;

    try {
      // Renewing claims alongside the run lease is the point: a claim outliving its holder is
      // what makes another agent wait on a resource nobody is using.
      if (agentRunId !== null) await this.client.partyHeartbeat(agentRunId, true, activity);
      if (sessionId !== null) await this.client.sessionHeartbeat(sessionId);
    } catch (error) {
      this.onError(
        `saga-mcp: heartbeat failed (${error instanceof Error ? error.message : 'unknown'}). ` +
          'The agent run lease may lapse; claims could be released while you still hold them.',
      );
    }
  }
}
