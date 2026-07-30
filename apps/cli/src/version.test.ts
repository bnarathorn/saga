import { describe, expect, it } from 'vitest';
import { checkApiCompatibility } from './version.js';

describe('API compatibility (spec 13.1 step 7)', () => {
  it('accepts an exact match', () => {
    expect(checkApiCompatibility('0.1.0', '0.1.0').verdict).toBe('compatible');
  });

  it('accepts a patch difference', () => {
    expect(checkApiCompatibility('0.1.7', '0.1.0').verdict).toBe('compatible');
  });

  it('refuses a major mismatch and says which side to upgrade', () => {
    const older = checkApiCompatibility('2.0.0', '1.4.0');
    expect(older.verdict).toBe('incompatible');
    // Assert the instruction, not the verb. This previously matched only /Upgrade the CLI/,
    // which is why `npm i -g @saga/cli` survived here for so long: the package is private and
    // has never been published, so the advice could not work, but it satisfied the regex.
    expect(older.action).toMatch(/pnpm -C apps\/cli link --global/);
    expect(older.action).not.toMatch(/npm i -g/);

    const newer = checkApiCompatibility('1.0.0', '2.1.0');
    expect(newer.verdict).toBe('incompatible');
    expect(newer.action).toMatch(/Upgrade the server/);
  });

  it('warns rather than fails on a 0.x minor difference, where semver allows breakage', () => {
    const result = checkApiCompatibility('0.2.0', '0.1.0');
    expect(result.verdict).toBe('unknown');
    expect(result.message).toMatch(/before 1\.0/);
  });

  it('treats a 1.x minor difference as compatible', () => {
    expect(checkApiCompatibility('1.4.0', '1.1.0').verdict).toBe('compatible');
  });

  it('does not turn an unreadable version into a failure', () => {
    // An unparseable string is missing evidence, not evidence of breakage.
    expect(checkApiCompatibility('dev', '0.1.0').verdict).toBe('unknown');
    expect(checkApiCompatibility('', '0.1.0').verdict).toBe('unknown');
  });

  it('accepts a leading v', () => {
    expect(checkApiCompatibility('v1.2.3', 'v1.0.0').verdict).toBe('compatible');
  });
});
