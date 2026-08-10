import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MCP_INSTRUCTIONS,
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
    const block = renderAgentInstructions();
    for (const line of MCP_INSTRUCTIONS.split('\n')) {
      expect(block).toContain(line);
    }
  });

  it('separates the policy into paragraphs, because a single newline is not a Markdown break', () => {
    expect(renderAgentInstructions()).toContain(
      'Before reading any file, call saga_start_session and read the Core Context it returns.\n\n',
    );
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

describe('--no-agent-instructions', () => {
  it('is off unless asked for, so an ordinary connect writes the files', () => {
    expect(parseFlags([]).agentInstructions).toBeUndefined();
  });

  it('declines the write when passed', () => {
    expect(parseFlags(['--no-agent-instructions']).agentInstructions).toBe(false);
  });
});
