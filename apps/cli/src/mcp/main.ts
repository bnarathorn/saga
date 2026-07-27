import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from './json-schema.js';
import { TOOLS, buildToolContext, toToolError } from './server.js';

/**
 * The Saga MCP stdio server.
 *
 * stdout carries the protocol, so nothing else may be written there: diagnostics go to
 * stderr, which is where an MCP host surfaces them.
 */
export async function runMcpServer(clientName = 'saga-mcp'): Promise<void> {
  const { context, problems } = await buildToolContext(clientName);
  for (const problem of problems) process.stderr.write(`saga-mcp: ${problem}\n`);

  const server = new Server(
    { name: 'saga', version: process.env.SAGA_VERSION ?? '0.1.0' },
    { capabilities: { tools: {} } },
  );

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
