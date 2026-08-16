import { CLI_VERSION } from './version.js';

// Re-exported because this module used to define it, and `saga --version` is the reason it is
// read here at all. The definition lives in ./version.ts, next to the check that compares it
// against the server.
export { CLI_VERSION };

const USAGE = `saga — shared project memory and work continuity for coding agents

Usage:
  saga connect              Bind this folder to a Saga project (guided)
  saga status               Show server, project, Quest and Party state
  saga doctor               Diagnose configuration and connectivity
  saga check-evidence       Report which recorded evidence files have changed,
                            marking the entries that read them stale
  saga mcp                  Run the MCP stdio server for this folder
  saga update               Install the CLI build this server is serving
  saga logout               Sign this machine out: the stored credentials, the
                            Saga session policy in AGENTS.md and CLAUDE.md, and
                            the saga MCP server registration

Options:
  -h, --help                Show this help
  -v, --version             Show the CLI version
      --json                Machine-readable output (status, doctor, update,
                            check-evidence)
      --include-missing     Report an evidence file that is not in this folder
                            as deleted, which marks its entries stale
                            (check-evidence). Only from a complete checkout
      --check               Report the available version without installing it
                            (update)
      --force               Reinstall even when the versions already match
                            (update)
      --insecure            Allow update over plain HTTP to a non-loopback host
                            (update)
      --server <url>        Override the Saga server URL
      --token <value>       Authorize with this token instead of the device flow;
                            it is not stored (connect). SAGA_TOKEN does the same
                            without putting the token in the process list
      --project <name>      Fail unless the token is bound to this project,
                            by name or id (connect)
      --reauth              Discard stored credentials and authorize again (connect)
      --no-agent-instructions
                            Leave AGENTS.md and CLAUDE.md alone: do not write the
                            Saga session policy into them (connect), and do not
                            take it back out (logout). They are project files the
                            whole team shares; the block between the saga:begin
                            and saga:end markers is the only part Saga owns
      --keep-mcp            Keep the saga MCP server registered in .mcp.json and
                            the Codex configuration (logout). Codex's file is
                            user-global, so removing the entry there removes it
                            for every project on this machine
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
