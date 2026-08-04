# saga-cli

The `saga` command: shared project memory and work continuity for coding agents.

This tarball is built from the Saga repository by `pnpm --filter @saga/cli bundle` and served by
the Saga server itself. It is not published to a registry, so install it by URL:

```
npx https://<your-server>/saga-cli-<version>.tgz connect --server https://<your-server>
```

Everything is bundled into a single file, so the install pulls no other packages. Node 22 or newer
is the only requirement.

```
saga connect   Bind a folder to a Saga project (guided)
saga status    Show server, project, Quest and Party state
saga doctor    Diagnose configuration and connectivity
saga mcp       Run the MCP stdio server for the current folder
saga update    Install the CLI build the server is serving
saga logout    Remove the stored credentials for a server
```

Run `saga --help` for the full option list.
