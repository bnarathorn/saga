import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noteLocalChange } from './local-changes.js';

/**
 * The session policy every Saga agent is expected to follow.
 *
 * Served two ways, from this one definition. Over MCP it is the `instructions` string of the
 * `initialize` result (`mcp/main.ts`), which is the only part of the protocol a host shows the
 * model before it has chosen to call anything. Written to disk it is the managed block in
 * `AGENTS.md` and `CLAUDE.md`, for hosts that do not surface `instructions` at all — Codex
 * being the one that prompted this: its agents opened a session, never called
 * `saga_activate_task`, and sat in `awaiting_task` heartbeating while the Quest board stayed
 * empty. Two channels, never two texts: a policy that disagrees with itself is worse than a
 * policy in one place.
 */
export const MCP_INSTRUCTIONS =
  'This folder is bound to a Saga project — shared memory and work continuity across agents.\n' +
  'Before reading any file, call saga_start_session and read the Core Context it returns.\n' +
  'When it reports bootstrap_required, this project has no Lore yet and nothing else will ' +
  'create it: work through the bootstrap_plan it returns as you read the code for the first ' +
  'task, and record what you find with saga_remember before you stop.\n' +
  'On the first user task call saga_activate_task with the request verbatim, and read the ' +
  'returned Task and Continuation context before editing anything.\n' +
  'Then break the work into numbered sub-tasks with saga_plan_quest, before you start ' +
  'changing things. Mark a step in_progress with step_updates on saga_checkpoint when you ' +
  'begin it, and settle it the same way when you finish it: the Quest completes by itself ' +
  'when the last step is settled, so the plan is what decides when the work is done.\n' +
  'When that Quest has completed and the user asks for something else, call saga_activate_task ' +
  'again — new work becomes a new Quest in the same session. Reopen the finished one with ' +
  'saga_reopen_quest only when it was closed by mistake.\n' +
  'Call saga_checkpoint at every milestone, before context compaction, when an important test ' +
  'finishes, before a risky operation and when work becomes blocked. You do not need one on a ' +
  'timer: Saga watches your tool calls in the background, so Guild Hall can already tell a ' +
  'working agent from a stalled one without interrupting you. Checkpoint because something ' +
  'happened worth recording. Claim shared resources with saga_claim_resource before risky ' +
  'operations. Record durable knowledge with saga_remember — never transient state, never ' +
  'credentials.\n' +
  'Call saga_end_session with a final handoff before you stop, so the next session can continue.';

/** The instruction files, by the host that reads each one. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

const BEGIN = '<!-- saga:begin — managed by `saga connect`, edits inside are replaced -->';
const END = '<!-- saga:end -->';

/**
 * Matched by prefix rather than in full, so the wording of the marker can change without
 * orphaning every block written by an older CLI — which would leave two Saga sections in the
 * file, the stale one indistinguishable from a hand-written note.
 */
const BEGIN_PREFIX = '<!-- saga:begin';

export interface AgentInstructionsResult {
  /** Files created, or whose managed block was refreshed. */
  written: string[];
  /** Files whose managed block already said exactly this, left byte-for-byte as they are. */
  unchanged: string[];
  /** Files left alone because writing to them would damage what is there, with the reason why. */
  skipped: { path: string; reason: string }[];
}

/**
 * Every snake_case identifier in the policy: tool names, and the response fields the policy
 * tells an agent to read.
 */
const IDENTIFIER = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** The managed block on its own, as it appears in the file. */
export function renderAgentInstructions(): string {
  const body = MCP_INSTRUCTIONS
    // Each line of the policy becomes its own paragraph: in Markdown a single newline is not a
    // break, so rendering it verbatim would run the whole policy into one wall of text.
    .split('\n')
    .join('\n\n')
    // CommonMark leaves an intra-word `_` alone, so `saga_activate_task` is safe by the spec —
    // but editors and looser renderers pair those underscores as emphasis and colour half the
    // block. They are identifiers either way, and a code span is what an identifier deserves.
    .replace(IDENTIFIER, '`$&`');
  return `${BEGIN}\n\n## Saga\n\n${body}\n\n${END}`;
}

/** What one instruction file says, relative to the policy this CLI carries. */
export type AgentInstructionsState =
  /** The managed block is there and says exactly this. */
  | 'current'
  /** A managed block is there and says something else — an older CLI wrote it. */
  | 'stale'
  /** No marker at all. The file may not even exist. */
  | 'absent'
  /** A `saga:begin` with no `saga:end`. Saga will not write here. */
  | 'unterminated';

/** One instruction file and what it says. */
export interface AgentInstructionsFile {
  path: string;
  state: AgentInstructionsState;
}

interface Located extends AgentInstructionsFile {
  /** The file as it is on disk, or `null` when there is no file. */
  existing: string | null;
  /** Bounds of the managed block in `existing`, when `state` is `current` or `stale`. */
  begin: number;
  end: number;
}

/**
 * Read one instruction file and say what its managed block is.
 *
 * The single classifier behind both the write and `saga doctor`'s report of it: a `doctor` that
 * decided "current" by its own reasoning would eventually disagree with what `connect` does,
 * and a diagnostic that contradicts the command it tells you to run is worse than none.
 */
function locate(path: string, block: string): Located {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const absent: Located = { path, state: 'absent', existing, begin: -1, end: -1 };
  if (existing === null) return absent;

  const begin = existing.indexOf(BEGIN_PREFIX);
  if (begin === -1) return absent;

  const endMarker = existing.indexOf(END, begin);
  if (endMarker === -1) return { path, state: 'unterminated', existing, begin, end: -1 };

  const end = endMarker + END.length;
  const state = existing.slice(begin, end) === block ? 'current' : 'stale';
  return { path, state, existing, begin, end };
}

/**
 * Put the policy in the instruction files this workspace's agents actually read.
 *
 * Only the region between the markers is ever Saga's. A file that exists without them keeps
 * everything it has and gains the block at the end; a file with them has that region replaced
 * and nothing else. This is what makes the write safe to repeat on every `saga connect` — the
 * alternative, owning a whole file, means either clobbering a team's own AGENTS.md or refusing
 * to write whenever one exists, and most repos already have one.
 */
export function writeAgentInstructions(root: string): AgentInstructionsResult {
  const result: AgentInstructionsResult = { written: [], unchanged: [], skipped: [] };
  const block = renderAgentInstructions();

  for (const found of locateAll(root, block)) {
    const { path, existing } = found;

    if (existing === null) {
      writeFile(path, `${block}\n`);
      result.written.push(path);
      continue;
    }

    if (found.state === 'current') {
      result.unchanged.push(path);
      continue;
    }

    if (found.state === 'unterminated') {
      // Replacing from an unterminated marker to the end of the file would delete whatever the
      // user wrote after it. There is no way to tell that content from a truncated block.
      result.skipped.push({ path, reason: UNTERMINATED_REASON });
      continue;
    }

    if (found.state === 'stale') {
      writeFile(path, `${existing.slice(0, found.begin)}${block}${existing.slice(found.end)}`);
      result.written.push(path);
      continue;
    }

    // A file the team already had, with no marker in it: every byte kept, the block at the end.
    const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    writeFile(path, `${existing}${separator}${block}\n`);
    result.written.push(path);
  }

  return result;
}

/** Why a file with a half-written marker is left alone, in both `connect` and `doctor`. */
const UNTERMINATED_REASON =
  'it contains a `<!-- saga:begin` marker with no matching `<!-- saga:end -->`. Saga ' +
  'left it untouched rather than guessing where the managed block stops. Close the ' +
  'marker, or delete it, and re-run `saga connect`';

/**
 * What each instruction file currently says, for `saga doctor`.
 *
 * Worth checking on its own: the whole reason these files exist is the host that never surfaces
 * the MCP `instructions` string, so for those agents a block that was deleted by a merge, or
 * left behind by an older CLI, is the difference between a policy and no policy — and nothing
 * about the session would look wrong until the Quest board stayed empty.
 */
export function agentInstructionsStatus(root: string): AgentInstructionsFile[] {
  return locateAll(root, renderAgentInstructions()).map(({ path, state }) => ({ path, state }));
}

function locateAll(root: string, block: string): Located[] {
  return INSTRUCTION_FILES.map((name) => locate(join(root, name), block));
}

function writeFile(path: string, content: string): void {
  writeFileSync(path, content);
  noteLocalChange(path);
}
