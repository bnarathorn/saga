import type { PartyService } from '@saga/party';
import type { QuestService, SessionService } from '@saga/quest';
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

// ---------------------------------------------------------------------------
// quest_plan_sweeper
// ---------------------------------------------------------------------------

export interface QuestPlanSweeperDeps {
  quests: QuestService;
}

/**
 * Closes Quests whose declared plan is finished and whose sessions have all gone.
 *
 * This is the half of plan-driven completion that survives a crash. A session that settles its
 * last step and then dies — no final handoff, no clean end — leaves a Quest that is demonstrably
 * finished and permanently `in_progress`, and `scoreCandidate` keeps offering it as a resume
 * candidate ahead of work that is actually open.
 *
 * It is a sweep, not an inference: it closes nothing that a plan someone wrote has not already
 * settled, and it applies the same two gates a session does — the project must be on
 * `quest_completion_mode = auto`, and no session may still be attached. Both are re-checked
 * under the Quest row lock, so a Quest picked up between the candidate scan and the write is
 * left alone rather than closed underneath its new session.
 */
export function createQuestPlanSweeperHandler(deps: QuestPlanSweeperDeps): JobHandler {
  return {
    type: 'quest_plan_sweeper',
    describe: {
      input: '{}',
      idempotency: 'A Quest already completed is not a candidate, so a repeat run is a no-op.',
      retryPolicy: 'Standard backoff; a missed run only delays the state change.',
      sideEffects:
        'Sets quest.work_items.status = completed for Quests whose plan is finished and which ' +
        'have no attached session, and emits quest.completed. Checkpoints and plan steps are ' +
        'untouched.',
      result: '{ completed: number, held: number, quest_ids: string[] }',
      failureCodes: [],
    },

    async handle({ signal }) {
      if (signal.aborted) throw JobHandlerError.retryable('The worker is shutting down.');
      const result = await deps.quests.sweepCompletedPlans();
      return {
        completed: result.completed.length,
        held: result.held,
        quest_ids: result.completed.slice(0, 50),
      };
    },
  };
}
