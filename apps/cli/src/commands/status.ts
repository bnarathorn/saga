import { SagaClient } from '@saga/agent-sdk';
import { CredentialStore } from '../credentials.js';
import { detectWorkspace, findBinding, loadConfig } from '../workspace.js';
import { describeKind, parseFlags } from './connect.js';

interface StatusReport {
  server: { url: string | null; reachable: boolean; version: string | null; health: string | null };
  workspace: { root: string; kind: string; label: string };
  project: {
    id: string;
    name: string;
    memory_revision: number;
    active_context_snapshot_id: string | null;
    bootstrap_required: boolean;
  } | null;
  party: { mode: string; active_agents: number; claims: number } | null;
  quests: { open: number; active_here: string | null } | null;
  authenticated: boolean;
  notes: string[];
}

/** `saga status` — what this folder is bound to and what Saga currently knows (spec 13.3). */
export async function statusCommand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const workspace = detectWorkspace();
  const config = loadConfig();
  const binding = findBinding(config, workspace.root);
  const serverUrl = flags.server ?? binding?.serverUrl ?? config.serverUrl ?? null;

  const report: StatusReport = {
    server: { url: serverUrl, reachable: false, version: null, health: null },
    workspace: {
      root: workspace.root,
      kind: workspace.kind,
      label: workspace.workspaceLabel,
    },
    project: null,
    party: null,
    quests: null,
    authenticated: false,
    notes: [],
  };

  if (serverUrl === null) {
    report.notes.push('This folder is not connected to a Saga server. Run `saga connect`.');
    return emit(report, flags.json === true, 1);
  }

  const live = await fetch(`${serverUrl}/health/live`).catch(() => null);
  report.server.reachable = live !== null && live.ok;
  if (!report.server.reachable) {
    report.notes.push(
      `The Saga API at ${serverUrl} is unreachable. Your local work is unaffected; retrying is safe.`,
    );
    return emit(report, flags.json === true, 1);
  }

  const token = await new CredentialStore().get(serverUrl);
  if (token === null) {
    report.notes.push('No stored credentials for this server. Run `saga connect`.');
    return emit(report, flags.json === true, 1);
  }

  const client = new SagaClient({ baseUrl: serverUrl, token, client: 'saga-cli', maxRetries: 1 });

  const who = await client.whoami().catch(() => null);
  report.authenticated = who?.authenticated === true;
  if (!report.authenticated) {
    report.notes.push('The stored credentials were rejected. Run `saga connect --reauth`.');
    return emit(report, flags.json === true, 1);
  }

  const health = await client.health().catch(() => null);
  report.server.health = health?.status ?? null;
  report.server.version = health?.version ?? null;

  const projectRef = binding?.projectId ?? who?.agent?.project_id ?? null;
  if (projectRef === null) {
    report.notes.push('This folder is not bound to a project. Run `saga connect`.');
    return emit(report, flags.json === true, 1);
  }

  const project = await client.project(projectRef).catch(() => null);
  if (project !== null) {
    const context = await client.context(projectRef, {}).catch(() => null);
    report.project = {
      id: project.project.id,
      name: project.project.name,
      memory_revision: project.project.memory_revision,
      active_context_snapshot_id: project.project.active_context_snapshot_id,
      bootstrap_required:
        context?.bootstrap_required ?? project.project.active_context_snapshot_id === null,
    };
    if (report.project.bootstrap_required) {
      report.notes.push(
        'Lore bootstrap is required: start an agent session so it can propose initial Lore from local evidence.',
      );
    }
  }

  const party = await client.partyStatus(projectRef).catch(() => null);
  if (party !== null) {
    report.party = {
      mode: party.mode,
      active_agents: party.active_agents.length,
      claims: party.claims.length,
    };
    // Only this workspace's agents matter for "is something running here".
    const here = party.active_agents.filter(
      (agent) => agent.workspace_label === workspace.workspaceLabel,
    );
    if (here.length > 0) {
      report.notes.push(
        `${here.length} agent run${here.length === 1 ? '' : 's'} active in this folder: ${here
          .map(
            (agent) =>
              `${agent.client}${agent.quest_title === null ? '' : ` on "${agent.quest_title}"`}`,
          )
          .join(', ')}.`,
      );
    }
    for (const overlap of party.overlaps.filter((entry) => entry.severity === 'critical')) {
      report.notes.push(`Overlap: ${overlap.message}`);
    }
  }

  const quests = await client.quests(projectRef, '?limit=100').catch(() => null);
  if (quests !== null) {
    const open = quests.items.filter(
      (quest) => quest.status !== 'completed' && quest.status !== 'cancelled',
    );
    const inProgress = open.find((quest) => quest.status === 'in_progress');
    report.quests = { open: open.length, active_here: inProgress?.title ?? null };
  }

  return emit(report, flags.json === true, 0);
}

function emit(report: StatusReport, json: boolean, code: number): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return code;
  }

  const out = process.stdout;
  const line = (label: string, value: string) => out.write(`  ${label.padEnd(22)}${value}\n`);

  out.write('\nSaga status\n\n');
  line('Server', report.server.url ?? 'not configured');
  line(
    'Reachable',
    report.server.reachable
      ? `yes${report.server.health === null ? '' : ` (${report.server.health})`}`
      : 'no',
  );
  line('Authenticated', report.authenticated ? 'yes' : 'no');
  line('Workspace', `${report.workspace.root} (${describeKind(report.workspace.kind)})`);
  line('Workspace label', report.workspace.label);

  if (report.project !== null) {
    out.write('\n');
    line('Project', report.project.name);
    line('Lore revision', String(report.project.memory_revision));
    line(
      'Core context',
      report.project.bootstrap_required
        ? 'not compiled — bootstrap required'
        : `active (${report.project.active_context_snapshot_id?.slice(0, 8) ?? 'unknown'})`,
    );
  }

  if (report.quests !== null) {
    line('Open Quests', String(report.quests.open));
    if (report.quests.active_here !== null) line('In progress', report.quests.active_here);
  }

  if (report.party !== null) {
    out.write('\n');
    line('Party mode', report.party.mode);
    line('Active agents', String(report.party.active_agents));
    line('Active claims', String(report.party.claims));
  }

  if (report.notes.length > 0) {
    out.write('\n');
    for (const note of report.notes) out.write(`  • ${note}\n`);
  }
  out.write('\n');
  return code;
}
