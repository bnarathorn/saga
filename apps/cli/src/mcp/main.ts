import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '@saga/shared';
import { CLI_VERSION } from '../version.js';
import { SessionHeartbeat } from './heartbeat.js';
import { zodToJsonSchema } from './json-schema.js';
import { MCP_INSTRUCTIONS, TOOLS, buildToolContext, openSession, toToolError } from './server.js';

/**
 * The Saga MCP stdio server.
 *
 * stdout carries the protocol, so nothing else may be written there: diagnostics go to
 * stderr, which is where an MCP host surfaces them.
 */
export async function runMcpServer(clientName = 'saga-mcp'): Promise<void> {
  const { context, problems } = await buildToolContext(clientName);
  for (const problem of problems) process.stderr.write(`saga-mcp: ${problem}\n`);

  const heartbeat = new SessionHeartbeat(context.client, context.session);
  context.heartbeat = heartbeat;
  // A host that kills the server mid-session should not leave the lease to time out silently.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      heartbeat.stop();
    });
  }

  const server = new Server(
    { name: 'saga', version: CLI_VERSION },
    // `instructions` is the only part of the protocol a host shows the model before it starts
    // work; tool descriptions are read when a tool is already being chosen. Without it, an agent
    // has the tools and no reason to call any of them.
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );

  /**
   * Register the agent the moment a client attaches, without waiting to be asked.
   *
   * The client reporting `initialize` for this folder is the fact Party wants to record: an
   * agent is working here. Deferring that to `saga_start_session` makes it conditional on the
   * model reading its instructions, and a model that skips them leaves no trace at all — no
   * session, no agent run, nothing in Guild Hall, while every check still reports healthy.
   */
  server.oninitialized = () => {
    // With no binding or no credentials there is nothing to open a session against; the reasons
    // have already gone to stderr, and a failing POST would only repeat them less clearly.
    if (problems.length > 0) return;
    // Deferred a tick because `initialized` is a notification: a client that writes it in the
    // same chunk as its `initialize` request has it dispatched before the SDK's own initialize
    // handler records `clientInfo`, and the agent would be registered nameless. A host that
    // waits for the response — every real one — is unaffected.
    setImmediate(() => {
      void openSession(context, server.getClientVersion()?.name).catch((error: unknown) => {
        process.stderr.write(`saga-mcp: could not open a session: ${errorMessage(error)}\n`);
      });
    });
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema),
    })),
  }));

  // The SDK's result union is wider than the tool-result shape Saga returns, so the handler
  // is registered with an explicit cast rather than widening every tool.
  server.setRequestHandler(CallToolRequestSchema, (async (request) => {
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      return toToolError(new Error(`Unknown tool: ${request.params.name}`));
    }

    try {
      const parsed = tool.inputSchema.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        return toToolError(
          new Error(
            `Invalid arguments for ${tool.name}: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.')} ${issue.message}`)
              .join('; ')}`,
          ),
        );
      }
      const result = await tool.handler(parsed.data as Record<string, unknown>, context);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return toToolError(error);
    }
  }) as Parameters<typeof server.setRequestHandler>[1]);

  await server.connect(new StdioServerTransport());
  process.stderr.write('saga-mcp: ready\n');
}
