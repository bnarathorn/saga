import type { QuestStepStatus } from '@saga/contracts';
import { describe, expect, it } from 'vitest';
import { planCompletesQuest, reconcilePlan, summarisePlan, type PlanStepState } from './plan.js';

const steps = (...statuses: QuestStepStatus[]): PlanStepState[] =>
  statuses.map((status, index) => ({ ordinal: index + 1, status }));

describe('planCompletesQuest', () => {
  it('completes when every step is settled and one was really done', () => {
    expect(planCompletesQuest(steps('done'))).toBe(true);
    expect(planCompletesQuest(steps('done', 'done', 'done'))).toBe(true);
    expect(planCompletesQuest(steps('done', 'skipped'))).toBe(true);
  });

  it('never completes a Quest that declared no plan', () => {
    // The whole backward-compatibility guarantee rests on this: a Quest with no steps closes
    // only when someone declares it closed, exactly as before plans existed.
    expect(planCompletesQuest([])).toBe(false);
  });

  it('holds the Quest open while any step is unsettled', () => {
    expect(planCompletesQuest(steps('done', 'pending'))).toBe(false);
    expect(planCompletesQuest(steps('done', 'in_progress'))).toBe(false);
    expect(planCompletesQuest(steps('pending'))).toBe(false);
  });

  it('does not treat an entirely skipped plan as finished work', () => {
    // This is the shape an abandoned or misjudged plan takes, and reporting it as success is
    // the one way a settled-steps rule could close a Quest nobody did anything to.
    expect(planCompletesQuest(steps('skipped'))).toBe(false);
    expect(planCompletesQuest(steps('skipped', 'skipped'))).toBe(false);
  });
});

describe('summarisePlan', () => {
  it('counts each status and points at the first unsettled step', () => {
    const progress = summarisePlan(steps('done', 'skipped', 'in_progress', 'pending'));
    expect(progress).toEqual({
      total: 4,
      done: 1,
      skipped: 1,
      remaining: 2,
      all_settled: false,
      next_ordinal: 3,
    });
  });

  it('reports no next step once the plan is finished', () => {
    const progress = summarisePlan(steps('done', 'done'));
    expect(progress.all_settled).toBe(true);
    expect(progress.next_ordinal).toBeNull();
  });

  it('picks the lowest unsettled ordinal, not the first in the array', () => {
    const progress = summarisePlan([
      { ordinal: 3, status: 'pending' },
      { ordinal: 1, status: 'done' },
      { ordinal: 2, status: 'pending' },
    ]);
    expect(progress.next_ordinal).toBe(2);
  });

  it('describes an empty plan without claiming it is settled', () => {
    expect(summarisePlan([])).toEqual({
      total: 0,
      done: 0,
      skipped: 0,
      remaining: 0,
      all_settled: false,
      next_ordinal: null,
    });
  });
});

describe('reconcilePlan', () => {
  const existing = [
    { id: 'a', ordinal: 1, title: 'Migration' },
    { id: 'b', ordinal: 2, title: 'Contracts' },
  ];

  it('carries a step over when its number and title both survive', () => {
    expect(reconcilePlan(existing, ['Migration', 'Contracts', 'Docs'])).toEqual([
      { ordinal: 1, title: 'Migration', carriedFromId: 'a' },
      { ordinal: 2, title: 'Contracts', carriedFromId: 'b' },
      { ordinal: 3, title: 'Docs', carriedFromId: null },
    ]);
  });

  it('starts a renamed step fresh', () => {
    expect(reconcilePlan(existing, ['Migration', 'Contracts and SDK'])).toEqual([
      { ordinal: 1, title: 'Migration', carriedFromId: 'a' },
      { ordinal: 2, title: 'Contracts and SDK', carriedFromId: null },
    ]);
  });

  it('starts every step fresh when one is inserted at the front', () => {
    // Titles shift by a position, so nothing matches: a step inserted at the top must not
    // inherit the completion recorded against whatever used to hold its number.
    expect(reconcilePlan(existing, ['Design', 'Migration', 'Contracts'])).toEqual([
      { ordinal: 1, title: 'Design', carriedFromId: null },
      { ordinal: 2, title: 'Migration', carriedFromId: null },
      { ordinal: 3, title: 'Contracts', carriedFromId: null },
    ]);
  });

  it('drops every step for an empty plan', () => {
    expect(reconcilePlan(existing, [])).toEqual([]);
  });
});
