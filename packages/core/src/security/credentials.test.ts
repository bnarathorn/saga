import { describe, expect, it } from 'vitest';
import { generateAgentToken, generateDeviceCode, normalizeUserCode } from './credentials.js';

const DEVICE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

describe('agent tokens', () => {
  it('never puts any part of the secret in the stored display prefix', () => {
    // `token_prefix` is returned by every token listing, forever. Spec 7.20 stores only hashes;
    // spec 17.2 shows the raw value once. A literal slice of the secret would break both.
    for (let i = 0; i < 200; i += 1) {
      const token = generateAgentToken('erp backoffice');
      const secret = token.raw.split('_')[2] ?? '';
      expect(secret.length).toBeGreaterThan(20);
      expect(token.prefix).not.toContain(secret);
      for (let length = 4; length <= secret.length; length += 1) {
        expect(token.prefix.includes(secret.slice(0, length))).toBe(false);
      }
    }
  });

  it('keeps the project slug in the prefix so an operator can tell tokens apart', () => {
    expect(generateAgentToken('erp backoffice').prefix).toMatch(/^saga_erpbackoffic_[0-9a-f]{6}$/);
  });

  it('gives every token a distinct secret', () => {
    const raws = new Set(Array.from({ length: 500 }, () => generateAgentToken('p').raw));
    expect(raws.size).toBe(500);
  });
});

describe('device user codes', () => {
  it('can produce every symbol in its alphabet', () => {
    // Regression: the code used to be derived as `base32Char.charCodeAt(i) % 31`, which made
    // A, B, C, D and 9 impossible and W-3 twice as likely as the rest.
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) {
      for (const character of generateDeviceCode().userCode.replace('-', '')) seen.add(character);
    }
    expect([...DEVICE_ALPHABET].filter((character) => !seen.has(character))).toEqual([]);
  });

  it('draws close to uniformly across the alphabet', () => {
    const counts = new Map<string, number>();
    const samples = 20_000;
    for (let i = 0; i < samples; i += 1) {
      for (const character of generateDeviceCode().userCode.replace('-', '')) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }
    const expected = (samples * 8) / DEVICE_ALPHABET.length;
    for (const character of DEVICE_ALPHABET) {
      const actual = counts.get(character) ?? 0;
      // A 2x skew was the actual defect; 25% tolerance catches it with no flake headroom lost.
      expect(actual).toBeGreaterThan(expected * 0.75);
      expect(actual).toBeLessThan(expected * 1.25);
    }
  });

  it('excludes look-alike characters so a code can be read aloud', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateDeviceCode().userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(generateDeviceCode().userCode).not.toMatch(/[ILO01]/);
    }
  });

  it('hashes the device code and never returns the hash as the code', () => {
    const { deviceCode, deviceCodeHash } = generateDeviceCode();
    expect(deviceCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceCodeHash).not.toContain(deviceCode);
  });

  it('normalises what a user types back to the stored form', () => {
    const { userCode } = generateDeviceCode();
    expect(normalizeUserCode(`  ${userCode.toLowerCase()} `)).toBe(userCode);
  });
});
