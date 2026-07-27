import type { PartyService } from '@saga/party';
import type { SessionService } from '@saga/quest';
import { JobHandlerError, type JobHandler } from '@saga/shrine';

export interface SessionReaperDeps {
  sessions: SessionService;
}

/**
 * Marks sessions abandoned once they stop reporting.
 *
 * A durable session outlives its process: the checkpoints it wrote stay, and a later session
 * can still resume the Quest. Abandoning it only records that no clean end ever arrived.
 */
export function createSessionReaperHandler(deps: SessionReaperDeps): JobHandler {
  return {
    type: 'session_reaper',
    describe: {
      input: '{}',
      idempotency: 'Abandoning an already abandoned session is a no-op.',
      retryPolicy: 'Standard backoff; a missed run only delays the state change.',
      sideEffects:
        'Sets quest.sessions.state = abandoned and emits quest.session_abandoned. Checkpoints and Quests are untouched.',
      result: '{ abandoned: number, session_ids: string[] }',
      failureCodes: [],
    },

    async handle({ signal }) {
      if (signal.aborted) throw JobHandlerError.retryable('The worker is shutting down.');
      const abandoned = await deps.sessions.reapStaleSessions();
      return { abandoned: abandoned.length, session_ids: abandoned.slice(0, 50) };
    },
  };
}

// ---------------------------------------------------------------------------
// party_reaper
// ---------------------------------------------------------------------------

export interface PartyReaperDeps {
  party: PartyService;
}

/**
 * Expires agent runs whose lease lapsed and releases their claims.
 *
 * The durable Quest session and every checkpoint survive untouched: only live coordination
 * state expires (spec 10.1).
 */
export function createPartyReaperHandler(deps: PartyReaperDeps): JobHandler {
  return {
    type: 'party_reaper',
    describe: {
      input: '{}',
      idempotency: 'Expiring an already expired run is a no-op.',
      retryPolicy: 'Standard backoff; leases stay expired until a run succeeds.',
      sideEffects:
        'Sets agent_runs.state = expired, releases their active claims, emits party.agent_expired. Quest sessions and checkpoints are untouched.',
      result: '{ expired: number, released_claims: number }',
      failureCodes: [],
    },

    async handle({ signal }) {
      if (signal.aborted) throw JobHandlerError.retryable('The worker is shutting down.');
      const result = await deps.party.reapExpiredRuns();
      return { expired: result.expired.length, released_claims: result.releasedClaims };
    },
  };
}
