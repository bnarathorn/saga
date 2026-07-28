import type { ClaimMode, PartyMode, ResourcePolicy, ResourceType } from '@saga/contracts';

/**
 * Default policy per resource type (spec 10.5).
 *
 * The split is between work that is *recoverable* if two agents collide, and work that is
 * not. Two agents editing the same module produce a merge problem a human can fix; two
 * agents running migrations against the same database produce a broken database.
 */
export const DEFAULT_POLICIES: Record<ResourceType, ResourcePolicy> = {
  module: 'advisory',
  file: 'advisory',
  database_schema: 'advisory',
  environment: 'advisory',
  service: 'advisory',
  // Fail-closed: a collision here is not recoverable by hand.
  migration_sequence: 'exclusive',
  test_environment: 'exclusive',
  deployment: 'exclusive',
  service_restart: 'exclusive',
  production_config: 'exclusive',
};

/** Resource types where Saga must refuse to proceed if coordination is unavailable. */
export const FAIL_CLOSED_TYPES: readonly ResourceType[] = [
  'migration_sequence',
  'test_environment',
  'deployment',
  'service_restart',
  'production_config',
];

export function defaultPolicyFor(resourceType: ResourceType): ResourcePolicy {
  return DEFAULT_POLICIES[resourceType];
}

export function isFailClosed(resourceType: ResourceType): boolean {
  return FAIL_CLOSED_TYPES.includes(resourceType);
}

export interface ExistingClaim {
  id: string;
  mode: ClaimMode;
  agentRunId: string;
  workItemId: string;
}

export interface ClaimDecisionInput {
  policy: ResourcePolicy;
  requestedMode: ClaimMode;
  partyMode: PartyMode;
  resourceType: ResourceType;
  /** Only claims whose lease has not expired. */
  activeClaims: readonly ExistingClaim[];
  requestingAgentRunId: string;
}

export type ClaimDecision =
  | { outcome: 'granted'; warnings: string[] }
  | { outcome: 'already_held'; claimId: string; warnings: string[] }
  | { outcome: 'denied'; conflictingClaimIds: string[]; reason: string };

/**
 * The claim policy matrix.
 *
 *   shared     never blocks; coexistence is the point
 *   advisory   never blocks, but reports overlap so agents can coordinate
 *   exclusive  blocks whenever any other claim is active on the resource
 *
 * `PARTY_MODE=off` disables Party entirely; `advisory` still enforces exclusive claims on
 * fail-closed resource types, because those are exactly the cases where a warning is not
 * enough.
 */
export function decideClaim(input: ClaimDecisionInput): ClaimDecision {
  const others = input.activeClaims.filter(
    (claim) => claim.agentRunId !== input.requestingAgentRunId,
  );
  const own = input.activeClaims.find(
    (claim) =>
      claim.agentRunId === input.requestingAgentRunId && claim.mode === input.requestedMode,
  );

  if (own !== undefined) {
    // Re-claiming is idempotent: an agent that retries after a timeout must not be blocked
    // by the claim it already holds.
    return { outcome: 'already_held', claimId: own.id, warnings: [] };
  }

  if (input.partyMode === 'off') {
    return {
      outcome: 'granted',
      warnings: ['PARTY_MODE=off: this claim is recorded but not enforced.'],
    };
  }

  const enforcing =
    input.partyMode === 'strict' ||
    (input.partyMode === 'advisory' && isFailClosed(input.resourceType));

  if (input.policy === 'shared') {
    return { outcome: 'granted', warnings: [] };
  }

  if (input.policy === 'advisory') {
    if (others.length === 0) return { outcome: 'granted', warnings: [] };
    return {
      outcome: 'granted',
      warnings: [
        `${others.length} other agent${others.length === 1 ? '' : 's'} already claimed this ${input.resourceType}. Coordinate before making conflicting changes.`,
      ],
    };
  }

  // Exclusive policy.
  if (others.length === 0) {
    if (input.requestedMode === 'shared') {
      return {
        outcome: 'granted',
        warnings: [
          `This ${input.resourceType} has an exclusive policy; a shared claim gives no protection.`,
        ],
      };
    }
    return { outcome: 'granted', warnings: [] };
  }

  if (!enforcing) {
    return {
      outcome: 'granted',
      warnings: [
        `PARTY_MODE=advisory: ${others.length} conflicting claim(s) exist on this ${input.resourceType} but were not enforced.`,
      ],
    };
  }

  return {
    outcome: 'denied',
    conflictingClaimIds: others.map((claim) => claim.id),
    reason:
      input.requestedMode === 'exclusive'
        ? `This ${input.resourceType} is already claimed and requires exclusive access.`
        : `This ${input.resourceType} requires exclusive access and is already claimed.`,
  };
}

/** Guidance for an agent when coordination itself is unavailable (spec 10.5). */
export function coordinationUnavailableGuidance(resourceType: ResourceType): string {
  return isFailClosed(resourceType)
    ? `Coordination is unavailable and "${resourceType}" is a fail-closed resource. Do not continue. Record a checkpoint describing the waiting state and the action required.`
    : `Coordination is unavailable, but "${resourceType}" is advisory. You may continue, and should assume another agent could be working on it.`;
}
