import { createInterface } from 'node:readline/promises';
import { SagaClient } from '@saga/agent-sdk';
import { errorMessage, isSagaError } from '@saga/shared';
import { writeAgentInstructions } from '../agent-instructions.js';
import { CredentialStore } from '../credentials.js';
import { writeMcpConfig } from '../mcp-config.js';
import { checkApiCompatibility } from '../version.js';
import {
  detectWorkspace,
  loadConfig,
  readProjectFile,
  updateConfig,
  upsertBinding,
  writeProjectFile,
} from '../workspace.js';

const DEFAULT_SERVER = 'http://localhost:4319';

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_at: string;
  interval_seconds: number;
}

interface DeviceStatus {
  state: string;
  token: string | null;
  project: { id: string; name: string } | null;
}

/**
 * `saga connect` — the one guided flow an ordinary user needs (spec 13.1).
 *
 * A Git remote is never required. A plain folder, a Git working copy without a remote and an
 * SVN working copy all connect identically: version control is local metadata only.
 */
export async function connectCommand(argv: string[]): Promise<number> {
  const out = process.stdout;
  const flags = parseFlags(argv);
  const workspace = detectWorkspace();
  const config = loadConfig();
  const credentials = new CredentialStore();

  const serverUrl = (
    flags.server ??
    process.env.SAGA_SERVER_URL ??
    config.serverUrl ??
    (await prompt(`Saga server URL [${DEFAULT_SERVER}]: `)) ??
    DEFAULT_SERVER
  )
    .trim()
    .replace(/\/$/, '');

  out.write(`\nServer: ${serverUrl}\n`);

  // 1. reachability, before anything else can plausibly work
  const live = await fetch(`${serverUrl}/health/live`).catch(() => null);
  if (live === null || !live.ok) {
    process.stderr.write(
      `\nCould not reach the Saga API at ${serverUrl}.\n` +
        `  Your local work is untouched; nothing was changed.\n` +
        `  Check the URL, then confirm the server is running (GET ${serverUrl}/health/live).\n` +
        `  Retrying is safe.\n`,
    );
    return 1;
  }

  // 2. authenticate: an existing token, an explicit SAGA_TOKEN, or the device flow
  let token = flags.token ?? (await credentials.get(serverUrl));
  if (token !== null && flags.reauth !== true) {
    const check = await fetch(`${serverUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (check === null || !check.ok) {
      out.write('Stored credentials are no longer valid; re-authenticating.\n');
      token = null;
    }
  } else if (flags.reauth === true) {
    token = null;
  }

  if (token === null) {
    const started = await postJson<DeviceStart>(`${serverUrl}/api/auth/device/start`, {
      client: 'saga-cli',
      workspace_label: workspace.workspaceLabel,
    });
    if (started === null) {
      process.stderr.write('The server refused to start a device authorization.\n');
      return 1;
    }

    out.write(
      `\nAuthorize this machine:\n` +
        `  1. Open ${started.verification_uri_complete}\n` +
        `  2. Sign in and approve the code ${started.user_code}\n\n` +
        `Waiting for approval…`,
    );

    token = await pollDeviceCode(serverUrl, started, out);
    if (token === null) {
      process.stderr.write(
        '\n\nThe authorization was not approved before it expired.\n' +
          '  Nothing was changed locally. Run `saga connect` again when you are ready.\n',
      );
      return 1;
    }

    const backend = await credentials.set(serverUrl, token);
    out.write(
      ` approved.\nToken stored in the ${backend === 'file' ? 'local credential file' : 'operating-system keychain'}.\n`,
    );
  } else {
    out.write('Authentication: existing credentials accepted.\n');
  }

  const client = new SagaClient({ baseUrl: serverUrl, token, client: 'saga-cli' });

  // 3. verify API compatibility before anything is written locally (spec 13.1 step 7).
  //    Only a *known* incompatibility stops the flow. `/api/shrine/health` needs the
  //    `shrine:health` permission, which a token approved with a narrower scope set than the
  //    default does not carry — and being unable to check the version is not a reason to
  //    refuse to bind a folder that `/health/live` has already answered for.
  const health = await client.health().then(
    (value) => value,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  if (health instanceof Error) {
    const code = isSagaError(health) ? health.code : 'UNKNOWN';
    out.write(
      `API compatibility: not verified (${code}).\n` +
        (code === 'SCOPE_REQUIRED' || code === 'FORBIDDEN'
          ? '  This token is not scoped to read server health. That is fine for ordinary use;\n' +
            '  run `saga doctor` with an operator session to check the version.\n'
          : '  The server did not answer /api/shrine/health. Run `saga doctor` for detail.\n'),
    );
  } else {
    const compatibility = checkApiCompatibility(health.version);
    if (compatibility.verdict === 'incompatible') {
      process.stderr.write(
        `\n${compatibility.message}\n` +
          `  Nothing was changed locally.\n` +
          `  ${compatibility.action ?? ''}\n`,
      );
      return 1;
    }
    out.write(
      compatibility.verdict === 'compatible'
        ? `API compatibility: ${compatibility.message}\n`
        : `API compatibility: ${compatibility.message}\n  ${compatibility.action ?? ''}\n`,
    );
  }

  // 4. the project is already decided: the token is minted bound to the project the approver
  //    chose, and bearer auth only ever resolves an agent token, so the CLI cannot pick one.
  //    `--project` therefore asserts rather than selects — it stops a folder being bound to
  //    the wrong project when several approvals are in flight.
  const who = await client.whoami().catch(() => null);
  if (who === null || who.agent === null) {
    process.stderr.write(
      '\nThe stored credential is not a project-scoped agent token.\n' +
        '  Run `saga connect --reauth` to authorize this machine again.\n',
    );
    return 1;
  }

  const project = await client.project(who.agent.project_id).catch(() => null);
  if (project === null) {
    process.stderr.write('\nThe project this token belongs to could not be read.\n');
    return 1;
  }

  if (flags.project !== undefined && !matchesProject(flags.project, project.project)) {
    process.stderr.write(
      `\nYou asked for project "${flags.project}", but this token is bound to ` +
        `"${project.project.name}" (${project.project.id}).\n` +
        '  Nothing was changed locally. The project is chosen when the device request is\n' +
        '  approved, not by this CLI. Ask for a token for the project you want, then run\n' +
        '  `saga connect --reauth`.\n',
    );
    return 1;
  }

  out.write(`\nLocal project type: ${describeKind(workspace.kind)}\n`);
  out.write(`Project: ${project.project.name}\n`);

  // 5. bind the folder. Under a lock, because a concurrent `saga connect` in another folder
  //    rewrites the same bindings array and would otherwise drop this one.
  const projectFile = writeProjectFile(workspace.root, project.project.name);
  updateConfig((current) =>
    upsertBinding(
      { ...current, serverUrl },
      {
        root: workspace.root,
        projectId: project.project.id,
        projectName: project.project.name,
        serverUrl,
        workspaceKey: workspace.workspaceKey,
        boundAt: new Date().toISOString(),
      },
    ),
  );

  out.write(`\nConnected this folder to "${project.project.name}".\n`);

  // 6. bootstrap state
  const context = await client.context(project.project.id, {}).catch(() => null);
  if (context?.bootstrap_required === true) {
    out.write('Lore bootstrap is required: this project has no core context yet.\n');
    out.write('  Start an agent session and let it propose initial Lore from local evidence.\n');
  } else if (context !== null) {
    out.write(`Core context is ready (Lore revision ${context.project.memory_revision}).\n`);
  }

  // 7. MCP configuration for Codex and Claude
  const mcp = writeMcpConfig({
    root: workspace.root,
    serverUrl,
    projectRef: project.project.id,
  });
  for (const file of mcp.written) out.write(`MCP configuration written: ${file}\n`);
  for (const file of mcp.unchanged) {
    out.write(
      `MCP configuration already present: ${file} (left as it is; edit it by hand to change the project).\n`,
    );
  }
  for (const file of mcp.skipped) {
    out.write(`MCP configuration NOT written: ${file.path} — ${file.reason}.\n`);
  }

  // 8. the session policy, in the files a host reads that does not surface MCP `instructions`.
  //    Unlike the MCP configuration this lands in files the whole team shares, so it says so
  //    plainly and `--no-agent-instructions` declines it.
  if (flags.agentInstructions === false) {
    out.write('Agent instructions: skipped (--no-agent-instructions).\n');
  } else {
    const instructions = writeAgentInstructions(workspace.root);
    for (const file of instructions.written) {
      out.write(`Agent instructions written: ${file} (in the \`saga:begin\` block).\n`);
    }
    for (const file of instructions.unchanged) {
      out.write(`Agent instructions already current: ${file}.\n`);
    }
    for (const file of instructions.skipped) {
      out.write(`Agent instructions NOT written: ${file.path} — ${file.reason}.\n`);
    }
    if (instructions.written.length > 0) {
      out.write(
        '  These are project files, not personal configuration: commit them so every agent ' +
          'on the project gets the same policy, or re-run with --no-agent-instructions.\n',
      );
    }
  }

  out.write(
    `\nNext: run \`saga status\` to confirm, or start your agent — Saga opens a session as soon ` +
      `as the agent's client connects, and Guild Hall shows it in Party.\n` +
      `Project file: ${projectFile}\n`,
  );

  const existing = readProjectFile(workspace.root);
  if (existing !== null && existing.project !== project.project.name) {
    out.write(
      `\nNote: .saga/project.yaml named "${existing.project}"; it now records "${project.project.name}". ` +
        `The server project id is authoritative.\n`,
    );
  }

  return 0;
}

async function pollDeviceCode(
  serverUrl: string,
  started: DeviceStart,
  out: NodeJS.WriteStream,
): Promise<string | null> {
  const deadline = new Date(started.expires_at).getTime();

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, started.interval_seconds * 1_000));
    out.write('.');

    const response = await fetch(
      `${serverUrl}/api/auth/device/status?device_code=${encodeURIComponent(started.device_code)}`,
    ).catch(() => null);
    if (response === null) continue;

    const status = (await response.json().catch(() => null)) as DeviceStatus | null;
    if (status === null) continue;
    // The raw token is handed over exactly once, on the first poll after approval.
    if (status.token !== null) return status.token;
    if (status.state === 'denied' || status.state === 'expired') return null;
  }
  return null;
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (response === null || !response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

async function prompt(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().length === 0 ? null : answer.trim();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return null;
  } finally {
    rl.close();
  }
}

export function describeKind(kind: string): string {
  switch (kind) {
    case 'git':
      return 'Git working copy (no remote required)';
    case 'svn':
      return 'SVN working copy';
    case 'mercurial':
      return 'Mercurial working copy';
    default:
      return 'plain folder';
  }
}

/** Accepts either the project's UUID or its display name, case-insensitively. */
export function matchesProject(requested: string, project: { id: string; name: string }): boolean {
  const wanted = requested.trim().toLowerCase();
  return wanted === project.id.toLowerCase() || wanted === project.name.toLowerCase();
}

export interface CliFlags {
  server?: string;
  token?: string;
  project?: string;
  reauth?: boolean;
  json?: boolean;
  debug?: boolean;
  /** `false` only when `--no-agent-instructions` was passed; absent means write them. */
  agentInstructions?: boolean;
  /** Report an evidence file that is not here as deleted (check-evidence). */
  includeMissing?: boolean;
}

export function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--server') flags.server = argv[++index];
    else if (arg === '--token') flags.token = argv[++index];
    else if (arg === '--project') flags.project = argv[++index];
    else if (arg === '--reauth') flags.reauth = true;
    else if (arg === '--no-agent-instructions') flags.agentInstructions = false;
    else if (arg === '--include-missing') flags.includeMissing = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--debug') flags.debug = true;
  }
  return flags;
}
