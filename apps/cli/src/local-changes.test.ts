import { afterEach, describe, expect, it } from 'vitest';
import {
  describeLocalChanges,
  localChanges,
  noteLocalChange,
  resetLocalChanges,
} from './local-changes.js';

afterEach(() => {
  resetLocalChanges();
});

describe('the local-change record behind the CLI error contract (spec 13.5)', () => {
  it('says nothing was modified when nothing was', () => {
    expect(describeLocalChanges()).toBe('Your local files were not modified.');
  });

  it('names the files that were written before the failure', () => {
    noteLocalChange('/tmp/project/.saga/project.yaml');
    noteLocalChange('/tmp/project/.mcp.json');

    const message = describeLocalChanges();
    // The old text claimed the opposite of the truth once `connect` had written anything.
    expect(message).not.toContain('were not modified');
    expect(message).toContain('/tmp/project/.saga/project.yaml');
    expect(message).toContain('/tmp/project/.mcp.json');
    expect(message).toMatch(/re-running the command overwrites them safely/);
  });

  it('records each path once however often it is written', () => {
    noteLocalChange('/tmp/a');
    noteLocalChange('/tmp/a');
    expect(localChanges()).toEqual(['/tmp/a']);
  });
});
