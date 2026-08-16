import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MCP_INSTRUCTIONS,
  removeAgentInstructions,
  renderAgentInstructions,
  writeAgentInstructions,
} from './agent-instructions.js';
import { resetLocalChanges } from './local-changes.js';
import { parseFlags } from './commands/connect.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saga-instructions-'));
  resetLocalChanges();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (name: string): string => readFileSync(join(root, name), 'utf8');

describe('renderAgentInstructions', () => {
  it('carries the policy itself, not a summary of it', () => {
    const plain = renderAgentInstructions().replaceAll('`', '');
    for (const line of MCP_INSTRUCTIONS.split('\n')) {
      expect(plain).toContain(line);
    }
  });

  it('separates the policy into paragraphs, because a single newline is not a Markdown break', () => {
    expect(renderAgentInstructions()).toContain(
      'Before reading any file, call `saga_start_session` and read the Core Context it returns.\n\n',
    );
  });

  it('code-spans every snake_case identifier, so no renderer reads the underscores as emphasis', () => {
    const block = renderAgentInstructions();
    for (const identifier of [
      'saga_start_session',
      'saga_activate_task',
      'saga_plan_quest',
      'saga_checkpoint',
      'saga_remember',
      'saga_end_session',
      'bootstrap_required',
      'bootstrap_plan',
      'step_updates',
      'in_progress',
    ]) {
      expect(block).toContain(`\`${identifier}\``);
    }
    // Nothing outside a code span may carry a bare underscore, which is what editors mis-pair.
    expect(block.replaceAll(/`[^`]+`/g, '')).not.toContain('_');
  });

  it('leaves the MCP instructions string itself plain: a protocol field is not Markdown', () => {
    expect(MCP_INSTRUCTIONS).not.toContain('`');
  });
});

describe('writeAgentInstructions', () => {
  it('creates both instruction files when neither exists', () => {
    const result = writeAgentInstructions(root);

    expect(result.written).toEqual([join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')]);
    expect(result.unchanged).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(read('AGENTS.md')).toContain('saga_activate_task');
    expect(read('CLAUDE.md')).toContain('saga_activate_task');
  });

  it('is idempotent: a second connect rewrites nothing', () => {
    writeAgentInstructions(root);
    const first = read('AGENTS.md');

    const again = writeAgentInstructions(root);

    expect(again.written).toEqual([]);
    expect(again.unchanged).toEqual([join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')]);
    expect(read('AGENTS.md')).toBe(first);
  });

  it("appends to a team's existing file without disturbing a byte of it", () => {
    const existing = '# Project rules\n\nRun the linter before pushing.\n';
    writeFileSync(join(root, 'AGENTS.md'), existing);

    writeAgentInstructions(root);

    const after = read('AGENTS.md');
    expect(after.startsWith(existing)).toBe(true);
    expect(after).toContain('saga_activate_task');
  });

  it('refreshes a stale block in place, keeping what surrounds it', () => {
    writeFileSync(
      join(root, 'AGENTS.md'),
      '# Rules\n\n<!-- saga:begin — managed by `saga connect` -->\nold policy\n<!-- saga:end -->\n\nRun the linter.\n',
    );

    const result = writeAgentInstructions(root);

    const after = read('AGENTS.md');
    expect(result.written).toContain(join(root, 'AGENTS.md'));
    expect(after).not.toContain('old policy');
    expect(after).toContain('saga_activate_task');
    expect(after).toContain('# Rules');
    expect(after).toContain('Run the linter.');
  });

  it('refuses an unterminated marker rather than eating the rest of the file', () => {
    const existing = '<!-- saga:begin -->\nhalf a block\n\n# Everything after it\n';
    writeFileSync(join(root, 'AGENTS.md'), existing);

    const result = writeAgentInstructions(root);

    expect(read('AGENTS.md')).toBe(existing);
    expect(result.written).not.toContain(join(root, 'AGENTS.md'));
    expect(result.skipped[0]?.path).toBe(join(root, 'AGENTS.md'));
    expect(result.skipped[0]?.reason).toMatch(/saga:end/);
  });
});

describe('removeAgentInstructions', () => {
  it('deletes a file `saga connect` created, because the block was all it held', () => {
    writeAgentInstructions(root);

    const result = removeAgentInstructions(root);

    expect(result.deleted).toEqual([join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')]);
    expect(result.removed).toEqual([]);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it("keeps every byte of a team's own file, block and its blank lines aside", () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Project rules\n\nRun the linter before pushing.\n');
    writeAgentInstructions(root);

    const result = removeAgentInstructions(root);

    expect(result.removed).toContain(join(root, 'AGENTS.md'));
    expect(read('AGENTS.md')).toBe('# Project rules\n\nRun the linter before pushing.\n');
  });

  it('rejoins what surrounded the block with a single blank line', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Rules\n\nRun the linter.\n');
    writeAgentInstructions(root);
    // The block went to the end of AGENTS.md, so put content after it as well.
    writeFileSync(join(root, 'AGENTS.md'), `${read('AGENTS.md')}\n## Afterwards\n`);

    removeAgentInstructions(root);

    expect(read('AGENTS.md')).toBe('# Rules\n\nRun the linter.\n\n## Afterwards\n');
  });

  it('removes a stale block an older CLI wrote, which no longer belongs here either', () => {
    writeFileSync(
      join(root, 'AGENTS.md'),
      '# Rules\n\n<!-- saga:begin — managed by `saga connect` -->\nold policy\n<!-- saga:end -->\n\nRun the linter.\n',
    );

    const result = removeAgentInstructions(root);

    expect(result.removed).toContain(join(root, 'AGENTS.md'));
    expect(read('AGENTS.md')).toBe('# Rules\n\nRun the linter.\n');
  });

  it('refuses an unterminated marker rather than cutting to the end of the file', () => {
    const existing = '<!-- saga:begin -->\nhalf a block\n\n# Everything after it\n';
    writeFileSync(join(root, 'AGENTS.md'), existing);

    const result = removeAgentInstructions(root);

    expect(read('AGENTS.md')).toBe(existing);
    expect(result.skipped[0]?.path).toBe(join(root, 'AGENTS.md'));
    expect(result.skipped[0]?.reason).toMatch(/saga:end/);
  });

  it('reports a file with no block as absent, and leaves a file it never wrote alone', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Rules only\n');

    const result = removeAgentInstructions(root);

    expect(result.absent).toEqual([join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')]);
    expect(read('AGENTS.md')).toBe('# Rules only\n');
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('undoes the write exactly, so connect and logout can alternate', () => {
    const existing = '# Project rules\n\nRun the linter before pushing.\n';
    writeFileSync(join(root, 'AGENTS.md'), existing);

    writeAgentInstructions(root);
    removeAgentInstructions(root);
    writeAgentInstructions(root);
    const afterSecondWrite = read('AGENTS.md');
    removeAgentInstructions(root);

    expect(afterSecondWrite).toContain('saga_activate_task');
    expect(read('AGENTS.md')).toBe(existing);
  });
});

describe('--no-agent-instructions', () => {
  it('is off unless asked for, so an ordinary connect writes the files', () => {
    expect(parseFlags([]).agentInstructions).toBeUndefined();
  });

  it('declines the write when passed', () => {
    expect(parseFlags(['--no-agent-instructions']).agentInstructions).toBe(false);
  });
});
