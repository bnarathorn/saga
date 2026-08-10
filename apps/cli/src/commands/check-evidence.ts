import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { SagaClient } from '@saga/agent-sdk';
import type { LoreEntryDto } from '@saga/contracts';
import { CredentialStore } from '../credentials.js';
import { detectWorkspace, findBinding, loadConfig } from '../workspace.js';
import { parseFlags } from './connect.js';

/** The request schema caps observations per call; more than this is sent in several calls. */
const OBSERVATIONS_PER_REQUEST = 500;

/** Entries per page when walking the project's Lore. The server clamps above 200. */
const ENTRY_PAGE_SIZE = 200;

interface Observation {
  path: string;
  content_hash: string | null;
}

interface CheckReport {
  workspace: string;
  /** Distinct evidence paths named by active entries. */
  evidence_paths: number;
  observed: number;
  /** Named by an entry but not present here, and not reported unless asked for. */
  missing: string[];
  /** Named by an entry but a directory, which has no content hash to compare. Never reported. */
  not_a_file: string[];
  /** Named by an entry but resolving outside the workspace, never read and never reported. */
  outside_workspace: string[];
  drifted: { memory_key: string; path: string; reason: string }[];
  marked_stale: string[];
  notes: string[];
}

/**
 * `saga check-evidence` — tell the server which of its recorded evidence files have changed.
 *
 * Saga records the files an entry was read out of, with a hash of each, and marks the entry
 * stale when one of them moves. The server cannot do that alone: it never reads the caller's
 * filesystem (`decision.product_commitments`), so the comparison needs somebody local to hash
 * the files and report what they saw. Nothing did. The route, the worker handler, the SDK
 * method and the recorded hashes all existed and had never once been used together — this
 * project's own Lore went four migrations claiming a schema version it no longer had, with
 * three of its evidence files already changed on disk.
 *
 * It is a command of its own rather than a step in `doctor` because it *writes*: an entry whose
 * evidence moved comes back stale. `doctor` diagnoses and changes nothing, and folding a
 * mutation into it would make a diagnostic unsafe to run.
 */
export async function checkEvidenceCommand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const workspace = detectWorkspace();
  const config = loadConfig();
  const binding = findBinding(config, workspace.root);
  const serverUrl = flags.server ?? binding?.serverUrl ?? config.serverUrl ?? null;

  const report: CheckReport = {
    workspace: workspace.root,
    evidence_paths: 0,
    observed: 0,
    missing: [],
    not_a_file: [],
    outside_workspace: [],
    drifted: [],
    marked_stale: [],
    notes: [],
  };

  if (serverUrl === null || binding === null) {
    report.notes.push('This folder is not bound to a Saga project. Run `saga connect`.');
    return emit(report, flags.json === true, 1);
  }

  const token = await new CredentialStore().get(serverUrl);
  if (token === null) {
    report.notes.push(`No stored credentials for ${serverUrl}. Run \`saga connect\`.`);
    return emit(report, flags.json === true, 1);
  }

  const client = new SagaClient({ baseUrl: serverUrl, token, client: 'saga-cli', maxRetries: 1 });
  const projectRef = binding.projectId;

  const entries = await listActiveEntries(client, projectRef).catch((error: unknown) => error);
  if (!Array.isArray(entries)) {
    report.notes.push(`Could not read the project's Lore: ${describe(entries)}`);
    return emit(report, flags.json === true, 1);
  }

  const paths = evidencePaths(entries);
  report.evidence_paths = paths.length;
  if (paths.length === 0) {
    report.notes.push('No active Lore Entry records evidence, so there is nothing to check.');
    return emit(report, flags.json === true, 0);
  }

  const observations: Observation[] = [];
  for (const path of paths) {
    const absolute = insideWorkspace(workspace.root, path);
    if (absolute === null) {
      // A path that escapes the workspace is never read. Evidence is recorded by whoever wrote
      // the entry, so it is not trusted input, and hashing `../../.ssh/id_rsa` because an entry
      // asked would report the contents of a file the project has no business seeing.
      report.outside_workspace.push(path);
      continue;
    }
    const seen = readFile(absolute);
    if (seen.kind === 'not-a-file') {
      // A directory is a legitimate thing to cite as evidence — `db/`, `docs/adr` — and it is
      // present, it simply has no bytes to hash. Reporting it as gone would mark its entries
      // stale for a folder that is sitting right there.
      report.not_a_file.push(path);
      continue;
    }
    if (seen.kind === 'absent') {
      report.missing.push(path);
      // Reported as a deletion only when asked. The server marks an entry stale for a path it
      // is told is gone, so a run from a shallow clone, a worktree missing a submodule, or
      // simply the wrong folder would mark the whole project stale in one call.
      if (flags.includeMissing === true) observations.push({ path, content_hash: null });
      continue;
    }
    observations.push({ path, content_hash: seen.hash });
  }

  report.observed = observations.length;
  if (report.missing.length > 0 && flags.includeMissing !== true) {
    report.notes.push(
      `${report.missing.length} evidence path(s) are not in this folder and were left unreported. ` +
        'Re-run with --include-missing to report them as deleted, but only from a complete checkout.',
    );
  }
  if (observations.length === 0) {
    report.notes.push('Nothing here to report on. No entry was touched.');
    return emit(report, flags.json === true, 0);
  }

  for (let index = 0; index < observations.length; index += OBSERVATIONS_PER_REQUEST) {
    const batch = observations.slice(index, index + OBSERVATIONS_PER_REQUEST);
    const result = await client
      .checkEvidence(projectRef, { observations: batch })
      .catch((error: unknown) => error);
    if (result instanceof Error) {
      report.notes.push(`The server rejected the report: ${describe(result)}`);
      return emit(report, flags.json === true, 1);
    }
    const response = result as Awaited<ReturnType<SagaClient['checkEvidence']>>;
    for (const entry of response.drifted) {
      report.drifted.push({
        memory_key: entry.memory_key,
        path: entry.path,
        reason: entry.reason,
      });
    }
    report.marked_stale.push(...response.marked_stale);
  }

  report.marked_stale = [...new Set(report.marked_stale)].sort();
  if (report.marked_stale.length > 0) {
    report.notes.push(
      'A stale entry drops out of Core Context — the context every session reads first — until ' +
        'it is re-recorded. It is still searched, and still shown in task context under a STALE ' +
        'label, so nothing is lost. Re-record it with saga_remember to put it back.',
    );
  }
  // Drift is the answer, not a failure: an entry going stale is this command working.
  return emit(report, flags.json === true, 0);
}

async function listActiveEntries(client: SagaClient, projectRef: string): Promise<LoreEntryDto[]> {
  const items: LoreEntryDto[] = [];
  let cursor: string | null = null;
  do {
    const query = `?state=active&limit=${ENTRY_PAGE_SIZE}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = await client.loreEntries(projectRef, query);
    items.push(...page.items);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor !== null);
  return items;
}

/**
 * Every distinct path named as evidence by a current version, in a stable order.
 *
 * Distinct because one file is commonly evidence for several entries — `AGENTS.md` backs four
 * here — and the server resolves each observation against every entry that names it, so sending
 * a path twice only makes the request bigger.
 */
export function evidencePaths(entries: readonly LoreEntryDto[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    for (const item of entry.current_version?.evidence ?? []) {
      const path = (item as { path?: unknown }).path;
      if (typeof path === 'string' && path.length > 0) paths.add(path);
    }
  }
  return [...paths].sort();
}

/**
 * The absolute path of `candidate` when it stays inside `root`, and `null` when it does not.
 *
 * `resolve` collapses `..` before the comparison, so neither a relative path that climbs out
 * nor an absolute one that starts elsewhere can pass.
 */
export function insideWorkspace(root: string, candidate: string): string | null {
  const base = resolve(root);
  const absolute = resolve(base, candidate);
  return absolute === base || absolute.startsWith(base + sep) ? absolute : null;
}

type Seen = { kind: 'hashed'; hash: string } | { kind: 'absent' } | { kind: 'not-a-file' };

/**
 * What is at `absolute`: its `sha256:<hex>`, nothing, or something that is not a file.
 *
 * The three are kept apart because only one of them means the evidence was deleted. An
 * unreadable path is reported as `not-a-file` rather than absent for the same reason: a
 * permission error is not a deletion, and saying it is would mark a live entry stale.
 */
function readFile(absolute: string): Seen {
  if (!existsSync(absolute)) return { kind: 'absent' };
  try {
    if (!statSync(absolute).isFile()) return { kind: 'not-a-file' };
    return {
      kind: 'hashed',
      hash: `sha256:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`,
    };
  } catch {
    return { kind: 'not-a-file' };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function emit(report: CheckReport, json: boolean, code: number): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return code;
  }

  const out = process.stdout;
  out.write('\nSaga evidence check\n\n');
  out.write(`  workspace   ${report.workspace}\n`);
  out.write(`  evidence    ${report.evidence_paths} path(s) named by active entries\n`);
  out.write(`  reported    ${report.observed}\n`);

  if (report.outside_workspace.length > 0) {
    out.write(`  skipped     ${report.outside_workspace.length} outside this folder:\n`);
    for (const path of report.outside_workspace) out.write(`                ${path}\n`);
  }
  if (report.not_a_file.length > 0) {
    out.write(`  directories ${report.not_a_file.length}, present but nothing to hash:\n`);
    for (const path of report.not_a_file) out.write(`                ${path}\n`);
  }
  if (report.missing.length > 0) {
    out.write(`  not found   ${report.missing.length}:\n`);
    for (const path of report.missing) out.write(`                ${path}\n`);
  }

  if (report.drifted.length === 0) {
    out.write('\n  Every file reported still matches what was recorded.\n');
  } else {
    out.write(`\n  ${report.drifted.length} entr(ies) drifted:\n`);
    for (const entry of report.drifted) {
      const why = entry.reason === 'path_missing' ? 'no longer exists' : 'changed';
      out.write(`    ${entry.memory_key}\n      ${entry.path} ${why}\n`);
    }
  }
  if (report.marked_stale.length > 0) {
    out.write(`\n  Marked stale: ${report.marked_stale.join(', ')}\n`);
  }

  for (const note of report.notes) out.write(`\n  ${note}\n`);
  out.write('\n');
  return code;
}
