import type { PartyMode, ResourceType } from '@saga/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICIES,
  coordinationUnavailableGuidance,
  decideClaim,
  defaultPolicyFor,
  isFailClosed,
  type ClaimDecisionInput,
  type ExistingClaim,
} from './policy.js';

const OTHER: ExistingClaim = {
  id: 'claim-other',
  mode: 'exclusive',
  agentRunId: 'run-b',
  workItemId: 'quest-b',
};

function decide(overrides: Partial<ClaimDecisionInput> = {}) {
  return decideClaim({
    policy: 'exclusive',
    requestedMode: 'exclusive',
    partyMode: 'strict',
    resourceType: 'migration_sequence',
    activeClaims: [],
    requestingAgentRunId: 'run-a',
    ...overrides,
  });
}

describe('default policies', () => {
  it('matches the documented guidance', () => {
    expect(defaultPolicyFor('module')).toBe('advisory');
    expect(defaultPolicyFor('file')).toBe('advisory');
    expect(defaultPolicyFor('migration_sequence')).toBe('exclusive');
    expect(defaultPolicyFor('test_environment')).toBe('exclusive');
    expect(defaultPolicyFor('deployment')).toBe('exclusive');
    expect(defaultPolicyFor('service_restart')).toBe('exclusive');
    expect(defaultPolicyFor('production_config')).toBe('exclusive');
  });

  it('assigns a policy to every resource type', () => {
    for (const type of Object.keys(DEFAULT_POLICIES) as ResourceType[]) {
      expect(defaultPolicyFor(type)).toBeDefined();
    }
  });

  it('marks exactly the irrecoverable resources as fail-closed', () => {
    expect(isFailClosed('migration_sequence')).toBe(true);
    expect(isFailClosed('deployment')).toBe(true);
    expect(isFailClosed('module')).toBe(false);
    expect(isFailClosed('file')).toBe(false);
  });
});

describe('claim decisions', () => {
  it('grants an uncontested exclusive claim', () => {
    expect(decide().outcome).toBe('granted');
  });

  it('denies a second exclusive claim on the same resource', () => {
    const decision = decide({ activeClaims: [OTHER] });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.conflictingClaimIds).toEqual(['claim-other']);
      expect(decision.reason).toContain('exclusive');
    }
  });

  it('lets shared claims coexist', () => {
    const decision = decide({
      policy: 'shared',
      requestedMode: 'shared',
      resourceType: 'module',
      activeClaims: [{ ...OTHER, mode: 'shared' }],
    });
    expect(decision.outcome).toBe('granted');
  });

  it('warns but does not block on an advisory overlap', () => {
    const decision = decide({
      policy: 'advisory',
      requestedMode: 'shared',
      resourceType: 'module',
      activeClaims: [{ ...OTHER, mode: 'shared' }],
    });
    expect(decision.outcome).toBe('granted');
    if (decision.outcome === 'granted') {
      expect(decision.warnings[0]).toContain('Coordinate');
    }
  });

  it('is idempotent when the same agent re-claims', () => {
    const decision = decide({
      activeClaims: [{ id: 'mine', mode: 'exclusive', agentRunId: 'run-a', workItemId: 'quest-a' }],
    });
    expect(decision.outcome).toBe('already_held');
    if (decision.outcome === 'already_held') expect(decision.claimId).toBe('mine');
  });

  it('records but does not enforce anything when Party is off', () => {
    const decision = decide({ partyMode: 'off', activeClaims: [OTHER] });
    expect(decision.outcome).toBe('granted');
    if (decision.outcome === 'granted') expect(decision.warnings[0]).toContain('PARTY_MODE=off');
  });

  it('still enforces fail-closed resources in advisory mode', () => {
    // A warning is not enough for a migration sequence.
    const decision = decide({
      partyMode: 'advisory',
      resourceType: 'migration_sequence',
      activeClaims: [OTHER],
    });
    expect(decision.outcome).toBe('denied');
  });

  it('does not enforce a non-critical exclusive resource in advisory mode', () => {
    const decision = decide({
      partyMode: 'advisory',
      resourceType: 'service',
      policy: 'exclusive',
      activeClaims: [OTHER],
    });
    expect(decision.outcome).toBe('granted');
    if (decision.outcome === 'granted') {
      expect(decision.warnings[0]).toContain('advisory');
    }
  });

  it('warns when a shared claim is taken on an exclusive resource', () => {
    const decision = decide({ requestedMode: 'shared', activeClaims: [] });
    expect(decision.outcome).toBe('granted');
    if (decision.outcome === 'granted') {
      expect(decision.warnings[0]).toContain('no protection');
    }
  });

  it.each<[PartyMode, string]>([
    ['strict', 'denied'],
    ['advisory', 'denied'],
    ['off', 'granted'],
  ])('in %s mode a contested migration sequence is %s', (partyMode, expected) => {
    expect(decide({ partyMode, activeClaims: [OTHER] }).outcome).toBe(expected);
  });
});

describe('guidance when coordination is unavailable', () => {
  it('tells the agent to stop for a fail-closed resource', () => {
    const guidance = coordinationUnavailableGuidance('deployment');
    expect(guidance).toContain('Do not continue');
    expect(guidance).toContain('checkpoint');
  });

  it('permits continuing for an advisory resource', () => {
    expect(coordinationUnavailableGuidance('module')).toContain('may continue');
  });
});
