import { describe, expect, it } from 'vitest';
import {
  AUTO_RESUME_THRESHOLD,
  classifyActivation,
  deriveQuestTitle,
  UNTITLED_QUEST,
  extractIssueKeys,
  hasContinuationIntent,
  looksLikeInquiry,
  scoreCandidate,
  type MatchInput,
  type QuestCandidate,
} from './activation.js';

const NOW = new Date('2026-03-01T12:00:00Z');

function candidate(
  overrides: Partial<QuestCandidate> & { id: string; title: string },
): QuestCandidate {
  return {
    objective: null,
    status: 'in_progress',
    scope: {},
    lastActivityAt: new Date('2026-03-01T10:00:00Z'),
    ...overrides,
  };
}

function match(overrides: Partial<MatchInput> & { task: string }): MatchInput {
  return {
    modeHint: 'auto',
    requestedQuestId: null,
    declaredScope: undefined,
    candidates: [],
    now: NOW,
    ...overrides,
  };
}

describe('intent detection', () => {
  it.each([
    'continue the refresh-token work',
    'resume AUTH-142',
    'pick this back up',
    'back to the CSV exporter',
    'where we left off yesterday',
    'finish the migration',
    "I'm still debugging the timeout",
  ])('recognises continuation intent in %s', (task) => {
    expect(hasContinuationIntent(task)).toBe(true);
  });

  it.each([
    'add CSV report export',
    'fix the refresh-token reuse detection',
    'implement token rotation',
  ])('does not see continuation intent in %s', (task) => {
    expect(hasContinuationIntent(task)).toBe(false);
  });

  it.each([
    'What does the auth module do?',
    'Explain how the outbox works',
    'walk me through the deployment',
    'Why is the worker slow?',
    'just looking around',
  ])('recognises inquiry in %s', (task) => {
    expect(looksLikeInquiry(task)).toBe(true);
  });

  it('treats an implementation request phrased as a question as work, not inquiry', () => {
    expect(looksLikeInquiry('How do I add CSV export to the report service?')).toBe(false);
    expect(looksLikeInquiry('Can you fix the failing integration test?')).toBe(false);
  });

  it('extracts issue keys', () => {
    expect(extractIssueKeys('Continue AUTH-142 and also SAGA-7')).toEqual(['AUTH-142', 'SAGA-7']);
    expect(extractIssueKeys('nothing here')).toEqual([]);
  });
});

describe('classification', () => {
  it('creates new work for an unrelated task, even with open Quests around', () => {
    // Scenario 1 of the specification: a new session must not inherit a stranger's handoff.
    const result = classifyActivation(
      match({
        task: 'Add CSV report export',
        candidates: [candidate({ id: 'q1', title: 'Fix refresh-token reuse detection' })],
      }),
    );
    expect(result.mode).toBe('new_work');
    expect(result.matched).toBeNull();
  });

  it('resumes when the caller names the Quest explicitly', () => {
    const quest = candidate({ id: 'q1', title: 'Fix refresh-token reuse detection' });
    const result = classifyActivation(
      match({ task: 'anything at all', requestedQuestId: 'q1', candidates: [quest] }),
    );
    expect(result.mode).toBe('resume_work');
    expect(result.matched?.id).toBe('q1');
  });

  it('falls back to classification when the named Quest is not available', () => {
    const result = classifyActivation(
      match({ task: 'Add CSV export', requestedQuestId: 'missing', candidates: [] }),
    );
    expect(result.mode).toBe('new_work');
  });

  it('resumes on explicit intent plus a strong match', () => {
    const quest = candidate({
      id: 'q1',
      title: 'Refresh-token reuse detection',
      scope: { issue_keys: ['AUTH-142'] },
    });
    const result = classifyActivation(
      match({ task: 'Continue AUTH-142: refresh-token reuse detection', candidates: [quest] }),
    );
    expect(result.mode).toBe('resume_work');
    expect(result.matched?.id).toBe('q1');
  });

  it('creates new work when intent is explicit but the match is weak', () => {
    // Better a redundant Quest than the wrong context.
    const result = classifyActivation(
      match({
        task: 'Continue working on something else entirely',
        candidates: [candidate({ id: 'q1', title: 'Refresh-token reuse detection' })],
      }),
    );
    expect(result.mode).toBe('new_work');
    expect(result.explanation).toContain('scored only');
  });

  it('creates new work on a strong match without continuation intent', () => {
    const quest = candidate({
      id: 'q1',
      title: 'Refresh-token reuse detection',
      scope: { issue_keys: ['AUTH-142'] },
    });
    const result = classifyActivation(
      match({ task: 'AUTH-142 refresh-token reuse detection', candidates: [quest] }),
    );
    expect(result.mode).toBe('new_work');
    // The match is still offered as a suggestion rather than being silently applied.
    expect(result.related[0]?.quest.id).toBe('q1');
  });

  it('classifies a question as inquiry and attaches no Quest', () => {
    const result = classifyActivation(
      match({
        task: 'What does the outbox delivery worker do?',
        candidates: [candidate({ id: 'q1', title: 'Outbox delivery worker' })],
      }),
    );
    expect(result.mode).toBe('inquiry');
    expect(result.matched).toBeNull();
  });

  it('never auto-resumes a completed Quest', () => {
    const quest = candidate({
      id: 'q1',
      title: 'Refresh-token reuse detection',
      status: 'completed',
      scope: { issue_keys: ['AUTH-142'] },
    });
    const result = classifyActivation(
      match({ task: 'Continue AUTH-142 refresh-token reuse detection', candidates: [quest] }),
    );
    expect(result.mode).toBe('new_work');
  });

  it('honours an explicit mode hint over classification', () => {
    const quest = candidate({
      id: 'q1',
      title: 'Refresh-token reuse detection',
      scope: { issue_keys: ['AUTH-142'] },
    });
    expect(
      classifyActivation(
        match({ task: 'Continue AUTH-142', modeHint: 'new_work', candidates: [quest] }),
      ).mode,
    ).toBe('new_work');

    expect(
      classifyActivation(
        match({ task: 'Add CSV export', modeHint: 'inquiry', candidates: [quest] }),
      ).mode,
    ).toBe('inquiry');

    expect(
      classifyActivation(
        match({ task: 'Something vague', modeHint: 'resume_work', candidates: [quest] }),
      ).mode,
    ).toBe('resume_work');
  });

  it('returns new_work when resume is requested but nothing is resumable', () => {
    const result = classifyActivation(
      match({
        task: 'Something',
        modeHint: 'resume_work',
        candidates: [candidate({ id: 'q1', title: 'Done thing', status: 'completed' })],
      }),
    );
    expect(result.mode).toBe('new_work');
  });

  it('ranks suggestions deterministically', () => {
    const candidates = [
      candidate({ id: 'q2', title: 'Refresh token rotation' }),
      candidate({ id: 'q1', title: 'Refresh token reuse detection' }),
    ];
    const first = classifyActivation(match({ task: 'refresh token work', candidates }));
    const second = classifyActivation(
      match({ task: 'refresh token work', candidates: [...candidates].reverse() }),
    );
    expect(first.related.map((entry) => entry.quest.id)).toEqual(
      second.related.map((entry) => entry.quest.id),
    );
  });
});

describe('scoring', () => {
  it('rewards an issue-key match heavily', () => {
    const scored = scoreCandidate(
      candidate({ id: 'q1', title: 'Unrelated title', scope: { issue_keys: ['AUTH-142'] } }),
      { task: 'Continue AUTH-142', declaredScope: undefined, now: NOW },
    );
    expect(scored.confidence).toBeGreaterThanOrEqual(0.5);
    expect(scored.reasons).toContain('issue key matches');
  });

  it('rewards declared scope overlap', () => {
    const scored = scoreCandidate(
      candidate({ id: 'q1', title: 'Unrelated', scope: { files: ['src/auth/refresh.ts'] } }),
      {
        task: 'work on tokens',
        declaredScope: { files: ['src/auth/refresh.ts'] },
        now: NOW,
      },
    );
    expect(scored.reasons.join(' ')).toContain('declared scope');
  });

  it('penalises a dormant Quest', () => {
    const fresh = scoreCandidate(candidate({ id: 'q1', title: 'Refresh token detection' }), {
      task: 'refresh token detection',
      declaredScope: undefined,
      now: NOW,
    });
    const dormant = scoreCandidate(
      candidate({
        id: 'q2',
        title: 'Refresh token detection',
        lastActivityAt: new Date('2025-01-01T00:00:00Z'),
      }),
      { task: 'refresh token detection', declaredScope: undefined, now: NOW },
    );
    expect(dormant.confidence).toBeLessThan(fresh.confidence);
  });

  it('keeps confidence inside [0,1]', () => {
    const scored = scoreCandidate(
      candidate({
        id: 'q1',
        title: 'Refresh token reuse detection',
        scope: { issue_keys: ['AUTH-142'], files: ['a.ts', 'b.ts', 'c.ts'] },
        similarity: 1,
      }),
      {
        task: 'Continue AUTH-142 refresh token reuse detection',
        declaredScope: { files: ['a.ts', 'b.ts', 'c.ts'] },
        now: NOW,
      },
    );
    expect(scored.confidence).toBeLessThanOrEqual(1);
    expect(scored.confidence).toBeGreaterThanOrEqual(AUTO_RESUME_THRESHOLD);
  });

  it('ignores stop words so unrelated Quests do not match', () => {
    const scored = scoreCandidate(candidate({ id: 'q1', title: 'Add the new thing' }), {
      task: 'Add the other thing',
      declaredScope: undefined,
      now: NOW,
    });
    expect(scored.confidence).toBeLessThan(AUTO_RESUME_THRESHOLD);
  });
});

describe('title derivation', () => {
  it('uses the first sentence', () => {
    expect(deriveQuestTitle('Add CSV report export. It should stream large results.')).toBe(
      'Add CSV report export',
    );
  });

  it('strips polite prefixes', () => {
    expect(deriveQuestTitle('Please add CSV report export')).toBe('Add CSV report export');
    expect(deriveQuestTitle('Can you fix the failing test')).toBe('Fix the failing test');
  });

  it('truncates on a word boundary', () => {
    const title = deriveQuestTitle('word '.repeat(60), 40);
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title.endsWith('…')).toBe(true);
  });

  it('handles a single very long word', () => {
    const title = deriveQuestTitle('x'.repeat(300), 30);
    expect(title.length).toBeLessThanOrEqual(30);
  });

  it('never returns a blank title', () => {
    // `work_items_title_not_blank` rejects an empty title, and a task of only whitespace or
    // punctuation used to strip down to one — surfacing as a raw constraint violation rather
    // than a domain error. Every one of these passes the API schema (`min(1)`).
    for (const task of ['   ', '???', '...', '!!!', '?', '   ...   ', '.', '\n\n', '\t']) {
      const title = deriveQuestTitle(task);
      expect(title.trim().length, `blank title for ${JSON.stringify(task)}`).toBeGreaterThan(0);
      expect(title).toBe(UNTITLED_QUEST);
    }
  });

  it('still prefers real text over the placeholder', () => {
    expect(deriveQuestTitle('Add CSV export???')).toBe('Add CSV export');
  });
});
