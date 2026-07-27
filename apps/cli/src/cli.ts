export const CLI_VERSION = process.env.SAGA_VERSION ?? '0.1.0';

const USAGE = `saga — shared project memory and work continuity for coding agents

Usage:
  saga connect              Bind this folder to a Saga project (guided)
  saga status               Show server, project, Quest and Party state
  saga doctor               Diagnose configuration and connectivity
  saga mcp                  Run the MCP stdio server for this folder
  saga logout               Remove the stored credentials for this server

Options:
  -h, --help                Show this help
  -v, --version             Show the CLI version
      --json                Machine-readable output (status, doctor)
      --server <url>        Override the Saga server URL
      --debug               Print stack traces
`;

export interface CommandHandler {
  (argv: string[]): Promise<number>;
}

const commands = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  commands.set(name, handler);
}

export function knownCommands(): string[] {
  return [...commands.keys()].sort();
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === '-v' || command === '--version' || command === 'version') {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  const handler = commands.get(command);
  if (handler === undefined) {
    process.stderr.write(
      `Unknown command "${command}". Known commands: ${knownCommands().join(', ') || 'none'}.\n\n${USAGE}`,
    );
    return 2;
  }

  return handler(rest);
}
