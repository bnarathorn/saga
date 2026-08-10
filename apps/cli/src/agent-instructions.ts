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
  'Call saga_checkpoint at every milestone, before context compaction, and at least every 10 ' +
  'minutes while you are still working — say what you are doing even when nothing has ' +
  'finished, because a Quest that has not moved for longer is indistinguishable in Guild Hall ' +
  'from an agent that died. Claim shared resources with saga_claim_resource before risky ' +
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

/** The managed block on its own, as it appears in the file. */
export function renderAgentInstructions(): string {
  // Each line of the policy becomes its own paragraph: in Markdown a single newline is not a
  // break, so rendering it verbatim would run the whole policy into one wall of text.
  const body = MCP_INSTRUCTIONS.split('\n').join('\n\n');
  return `${BEGIN}\n\n## Saga\n\n${body}\n\n${END}`;
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

  for (const name of INSTRUCTION_FILES) {
    const path = join(root, name);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;

    if (existing === null) {
      writeFile(path, `${block}\n`);
      result.written.push(path);
      continue;
    }

    const begin = existing.indexOf(BEGIN_PREFIX);
    if (begin === -1) {
      const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      writeFile(path, `${existing}${separator}${block}\n`);
      result.written.push(path);
      continue;
    }

    const endMarker = existing.indexOf(END, begin);
    if (endMarker === -1) {
      // Replacing from an unterminated marker to the end of the file would delete whatever the
      // user wrote after it. There is no way to tell that content from a truncated block.
      result.skipped.push({
        path,
        reason:
          'it contains a `<!-- saga:begin` marker with no matching `<!-- saga:end -->`. Saga ' +
          'left it untouched rather than guessing where the managed block stops. Close the ' +
          'marker, or delete it, and re-run `saga connect`',
      });
      continue;
    }

    const end = endMarker + END.length;
    if (existing.slice(begin, end) === block) {
      result.unchanged.push(path);
      continue;
    }

    writeFile(path, `${existing.slice(0, begin)}${block}${existing.slice(end)}`);
    result.written.push(path);
  }

  return result;
}

/** Where the block would go, for `saga doctor` and for reporting a skip. */
export function agentInstructionPaths(root: string): string[] {
  return INSTRUCTION_FILES.map((name) => join(root, name));
}

function writeFile(path: string, content: string): void {
  writeFileSync(path, content);
  noteLocalChange(path);
}
