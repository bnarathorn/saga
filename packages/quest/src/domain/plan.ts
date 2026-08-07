import type { PlanProgressDto, QuestStepStatus } from '@saga/contracts';

/**
 * Plan progress, and the one rule that decides whether a plan has finished the Quest (ADR-0011).
 *
 * Pure, because every caller needs the same answer from a different place: the checkpoint path
 * decides it inside a transaction it already holds, the sweeper decides it for Quests nobody is
 * attached to, and Guild Hall renders it from an HTTP response.
 */

export interface PlanStepState {
  ordinal: number;
  status: QuestStepStatus;
}

const SETTLED: readonly QuestStepStatus[] = ['done', 'skipped'];

export function isSettled(status: QuestStepStatus): boolean {
  return SETTLED.includes(status);
}

export function summarisePlan(steps: readonly PlanStepState[]): PlanProgressDto {
  const done = steps.filter((step) => step.status === 'done').length;
  const skipped = steps.filter((step) => step.status === 'skipped').length;
  const unsettled = steps
    .filter((step) => !isSettled(step.status))
    .sort((left, right) => left.ordinal - right.ordinal);

  return {
    total: steps.length,
    done,
    skipped,
    remaining: unsettled.length,
    all_settled: planCompletesQuest(steps),
    next_ordinal: unsettled[0]?.ordinal ?? null,
  };
}

/**
 * True when the plan itself says the Quest is finished.
 *
 * Three conditions, and each rules out a way this could close a Quest that is not done:
 *
 *   - at least one step, so a Quest that never declared a plan is never closed by this path;
 *   - every step settled, so outstanding work still holds the Quest open;
 *   - at least one step actually `done`, so an agent that skips its way through a plan — the
 *     shape an abandoned or misjudged plan takes — does not thereby report success.
 *
 * `next_steps` is deliberately not consulted. An agent records what it would do next as a
 * matter of course, and treating that as unfinished work is exactly the inference that left
 * finished Quests open for ever.
 */
export function planCompletesQuest(steps: readonly PlanStepState[]): boolean {
  if (steps.length === 0) return false;
  if (!steps.every((step) => isSettled(step.status))) return false;
  return steps.some((step) => step.status === 'done');
}

/**
 * Reconcile a re-declared plan against the one on record.
 *
 * A step keeps its status when its number and title both survive; anything renamed, inserted or
 * reordered is a different step and starts `pending`. That lets an agent append to its plan
 * mid-Quest without losing what it already recorded, and stops a rewritten plan from inheriting
 * completions that were never about the new work.
 */
export interface ReconciledStep {
  ordinal: number;
  title: string;
  /** The existing step whose status carries over, or null when this step is new. */
  carriedFromId: string | null;
}

export function reconcilePlan(
  existing: readonly { id: string; ordinal: number; title: string }[],
  titles: readonly string[],
): ReconciledStep[] {
  const byOrdinal = new Map(existing.map((step) => [step.ordinal, step]));
  return titles.map((title, index) => {
    const ordinal = index + 1;
    const previous = byOrdinal.get(ordinal);
    return {
      ordinal,
      title,
      carriedFromId: previous !== undefined && previous.title === title ? previous.id : null,
    };
  });
}
