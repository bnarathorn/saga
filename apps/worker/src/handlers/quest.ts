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
