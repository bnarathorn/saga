import { existsSync } from 'node:fs';
import { SagaClient } from '@saga/agent-sdk';
import { CredentialStore } from '../credentials.js';
import { mcpConfigPaths } from '../mcp-config.js';
import { checkApiCompatibility } from '../version.js';
import { configPath, detectWorkspace, findBinding, loadConfig } from '../workspace.js';
import { parseFlags } from './connect.js';

type CheckStatus = 'ok' | 'warning' | 'failure';

interface Check {
  name: string;
  status: CheckStatus;
  message: string;
  /** What the user should do next. Absent when nothing is required. */
  action?: string;
}

/**
 * `saga doctor` — diagnose configuration and connectivity (spec 13.4).
 *
 * A warning is something the user may want to know; a failure is something that stops Saga
 * working. Only failures make the exit code non-zero, so `doctor` is usable in CI.
 */
export async function doctorCommand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const checks: Check[] = [];

  const workspace = detectWorkspace();
  const config = loadConfig();
  const binding = findBinding(config, workspace.root);
  const serverUrl = flags.server ?? binding?.serverUrl ?? config.serverUrl ?? null;

  checks.push({
    name: 'workspace',
    status: 'ok',
    message: `${workspace.root} (${workspace.kind}); label ${workspace.workspaceLabel}`,
  });

  checks.push(
    binding === null
      ? {
          name: 'project binding',
          status: 'failure',
          message: 'This folder is not bound to a Saga project.',
          action: 'Run `saga connect`.',
        }
      : {
          name: 'project binding',
          status: 'ok',
          message: `${binding.projectName} (${binding.projectId})`,
        },
  );

  checks.push({
    name: 'configuration file',
    status: existsSync(configPath()) ? 'ok' : 'warning',
    message: configPath(),
    ...(existsSync(configPath()) ? {} : { action: 'Run `saga connect` to create it.' }),
  });

  const credentials = new CredentialStore();
  const keychain = await credentials.status();
  checks.push({
    name: 'credential storage',
    // A token from the environment is a deliberate choice, not a fallback: no warning.
    status: keychain.backend === 'file' ? 'warning' : 'ok',
    message: keychain.detail,
    ...(keychain.backend === 'file'
      ? { action: 'Install an OS keychain helper, or set SAGA_TOKEN for non-interactive use.' }
      : {}),
  });

  if (serverUrl === null) {
    checks.push({
      name: 'server',
      status: 'failure',
      message: 'No server URL configured.',
      action: 'Run `saga connect`.',
    });
    return report(checks, flags.json === true);
  }

  checks.push({
    name: 'server url',
    status: serverUrl.startsWith('https://') ? 'ok' : 'warning',
    message: serverUrl,
    ...(serverUrl.startsWith('https://')
      ? {}
      : {
          action:
            'This server is not using TLS. That is fine for local development; use HTTPS for anything shared.',
        }),
  });

  const live = await fetch(`${serverUrl}/health/live`).catch(() => null);
  if (live === null || !live.ok) {
    checks.push({
      name: 'reachability',
      status: 'failure',
      message: `Could not reach ${serverUrl}.`,
      action: 'Check the URL and that the API process is running. Your local work is unaffected.',
    });
    return report(checks, flags.json === true);
  }
  checks.push({
    name: 'reachability',
    status: 'ok',
    message: `${serverUrl}/health/live answered.`,
  });

  const ready = await fetch(`${serverUrl}/health/ready`).catch(() => null);
  const readyBody = (await ready?.json().catch(() => null)) as {
    status: string;
    checks: { name: string; status: string; message: string }[];
  } | null;
  if (readyBody !== null) {
    const failing = readyBody.checks.filter((check) => check.status === 'unhealthy');
    checks.push({
      name: 'server readiness',
      status: failing.length === 0 ? 'ok' : 'failure',
      message:
        failing.length === 0
          ? 'The API reports itself ready.'
          : failing.map((check) => `${check.name}: ${check.message}`).join('; '),
      ...(failing.length === 0 ? {} : { action: 'Check the server logs and the database.' }),
    });
  }

  const token = await credentials.get(serverUrl);
  if (token === null) {
    checks.push({
      name: 'authentication',
      status: 'failure',
      message: 'No credentials stored for this server.',
      action: 'Run `saga connect`.',
    });
    return report(checks, flags.json === true);
  }

  const client = new SagaClient({ baseUrl: serverUrl, token, client: 'saga-cli', maxRetries: 1 });
  const who = await client.whoami().catch(() => null);

  if (who === null || !who.authenticated) {
    checks.push({
      name: 'authentication',
      status: 'failure',
      message: 'The stored credentials were rejected.',
      action: 'Run `saga connect --reauth`.',
    });
  } else {
    checks.push({
      name: 'authentication',
      status: 'ok',
      message:
        who.agent === null
          ? `Signed in as ${who.actor_type}.`
          : `Project-scoped agent token "${who.agent.name}" with scopes: ${who.agent.scopes.join(', ')}.`,
    });

    if (who.agent !== null && binding !== null && who.agent.project_id !== binding.projectId) {
      checks.push({
        name: 'token scope',
        status: 'failure',
        message: 'The stored token belongs to a different project than this folder is bound to.',
        action: 'Run `saga connect --reauth` to authorize this folder again.',
      });
    }
  }

  const health = await client.health().catch(() => null);
  if (health === null) {
    checks.push({
      name: 'api compatibility',
      status: 'failure',
      message: 'The server did not answer /api/shrine/health.',
      action: 'Check the server logs; the API is reachable but not serving its health endpoint.',
    });
  } else {
    const compatibility = checkApiCompatibility(health.version);
    checks.push({
      name: 'api compatibility',
      status:
        compatibility.verdict === 'compatible'
          ? 'ok'
          : compatibility.verdict === 'unknown'
            ? 'warning'
            : 'failure',
      message: `${compatibility.message} Server health ${health.status}.`,
      ...(compatibility.action === undefined ? {} : { action: compatibility.action }),
    });

    const detailed = (await fetch(`${serverUrl}/api/shrine/health`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then((response) => response.json())
      .catch(() => null)) as {
      checks?: { name: string; status: string; message: string }[];
    } | null;

    for (const name of ['workers', 'embedding_provider', 'job_queue']) {
      const check = detailed?.checks?.find((entry) => entry.name === name);
      if (check === undefined) continue;
      checks.push({
        name: `server: ${name}`,
        // A degraded worker or embedding provider is worth knowing about, but Saga still works.
        status:
          check.status === 'healthy' ? 'ok' : check.status === 'unhealthy' ? 'failure' : 'warning',
        message: check.message,
      });
    }
  }

  if (binding !== null) {
    const party = await client.partyStatus(binding.projectId).catch(() => null);
    checks.push({
      name: 'party',
      status: 'ok',
      message:
        party === null
          ? 'Party status could not be read.'
          : party.mode === 'off'
            ? 'Coordination is disabled on this server (PARTY_MODE=off). Lore and Quest are unaffected.'
            : `Coordination is ${party.mode}; ${party.active_agents.length} agent(s) active.`,
    });
  }

  const mcpPaths = mcpConfigPaths(workspace.root);
  const present = mcpPaths.filter((path) => existsSync(path));
  checks.push({
    name: 'mcp configuration',
    status: present.length > 0 ? 'ok' : 'warning',
    message: present.length > 0 ? present.join(', ') : 'No MCP configuration found in this folder.',
    ...(present.length > 0 ? {} : { action: 'Run `saga connect` to write it.' }),
  });

  checks.push({
    name: 'guild hall',
    status: 'ok',
    message: guildHallUrl(serverUrl),
  });

  return report(checks, flags.json === true);
}

// Every deployment except the development stack serves Guild Hall from the API's own origin:
// nginx serves the static build at / and proxies /api to the same host and port, which is what
// makes the console same-origin and CORS-free. Talking to the API on its own loopback port is the
// one case where the console lives elsewhere — `pnpm dev` runs Vite beside it on 4320.
const DEV_API_PORT = '4319';
const DEV_WEB_PORT = '4320';

export function guildHallUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return serverUrl;
  }

  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (loopback && url.port === DEV_API_PORT) {
    url.port = DEV_WEB_PORT;
    return `${display(url)} (development stack: Vite serves Guild Hall separately).`;
  }

  return `${display(url)} (served from this origin).`;
}

// A server URL may carry a path prefix — everything else in this command appends to it rather
// than to the origin — so only the trailing slash of a bare origin is dropped.
function display(url: URL): string {
  return url.pathname === '/' ? url.origin : url.href.replace(/\/$/, '');
}

function report(checks: Check[], json: boolean): number {
  const failures = checks.filter((check) => check.status === 'failure');
  const warnings = checks.filter((check) => check.status === 'warning');

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ checks, failures: failures.length, warnings: warnings.length }, null, 2)}\n`,
    );
    return failures.length === 0 ? 0 : 1;
  }

  const out = process.stdout;
  out.write('\nSaga doctor\n\n');
  for (const check of checks) {
    const mark = check.status === 'ok' ? '✓' : check.status === 'warning' ? '!' : '✗';
    out.write(`  ${mark} ${check.name.padEnd(22)}${check.message}\n`);
    if (check.action !== undefined) out.write(`      → ${check.action}\n`);
  }

  out.write(
    `\n${checks.length - failures.length - warnings.length} ok, ${warnings.length} warning(s), ${failures.length} failure(s)\n\n`,
  );
  // Warnings alone must not fail CI.
  return failures.length === 0 ? 0 : 1;
}
