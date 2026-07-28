import type { QuestStatus } from '@saga/contracts';

/**
 * Deterministic parent-state projection for a Questline (spec 9.6).
 *
 * A parent whose status was set manually is never overwritten: an operator's judgement
 * outranks a derived value, and silently reverting it would be worse than a stale label.
 */
export interface ChildState {
  status: QuestStatus;
}

export interface ProjectionInput {
  currentParentStatus: QuestStatus;
  parentStatusSetManually: boolean;
  children: readonly ChildState[];
}

export interface ProjectionResult {
  status: QuestStatus;
  changed: boolean;
  reason: string;
}

const ACTIVE: readonly QuestStatus[] = ['open', 'in_progress', 'waiting', 'blocked'];

export function projectParentStatus(input: ProjectionInput): ProjectionResult {
  const keep = (reason: string): ProjectionResult => ({
    status: input.currentParentStatus,
    changed: false,
    reason,
  });

  if (input.currentParentStatus === 'cancelled') {
    return keep('The parent was explicitly cancelled.');
  }
  if (input.parentStatusSetManually) {
    return keep('The parent status was set manually and is not overwritten by projection.');
  }
  if (input.children.length === 0) {
    return keep('The Quest has no children, so there is nothing to project.');
  }

  const nonCancelled = input.children.filter((child) => child.status !== 'cancelled');
  if (nonCancelled.length === 0) {
    return decide(input, 'cancelled', 'Every child was cancelled.');
  }

  if (nonCancelled.every((child) => child.status === 'completed')) {
    return decide(input, 'completed', 'All non-cancelled children are completed.');
  }

  const active = nonCancelled.filter((child) => ACTIVE.includes(child.status));

  if (active.some((child) => child.status === 'in_progress')) {
    return decide(input, 'in_progress', 'At least one child is in progress.');
  }
  if (active.length > 0 && active.some((child) => child.status === 'blocked')) {
    return decide(input, 'blocked', 'A child is blocked and no child is in progress.');
  }
  if (active.length > 0 && active.every((child) => child.status === 'waiting')) {
    return decide(input, 'waiting', 'Every active child is waiting.');
  }

  return decide(input, 'open', 'Children remain open.');
}

function decide(input: ProjectionInput, status: QuestStatus, reason: string): ProjectionResult {
  return { status, changed: status !== input.currentParentStatus, reason };
}

// --- graph safety ----------------------------------------------------------

export interface GraphEdge {
  from: string;
  to: string;
}

/**
 * True when adding `from -> to` would create a cycle. Used for both the parent chain and the
 * dependency graph: a Questline that contains itself, or a dependency ring, would make
 * projection and scheduling non-terminating.
 */
export function wouldCreateCycle(edges: readonly GraphEdge[], from: string, to: string): boolean {
  if (from === to) return true;

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  // A cycle appears exactly when `to` can already reach `from`.
  const seen = new Set<string>([to]);
  const queue = [to];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === from) return true;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/** The statuses a Quest may move to directly. */
export const STATUS_TRANSITIONS: Record<QuestStatus, readonly QuestStatus[]> = {
  open: ['in_progress', 'waiting', 'blocked', 'completed', 'cancelled'],
  in_progress: ['open', 'waiting', 'blocked', 'completed', 'cancelled'],
  waiting: ['open', 'in_progress', 'blocked', 'completed', 'cancelled'],
  blocked: ['open', 'in_progress', 'waiting', 'completed', 'cancelled'],
  // Reopening is deliberate and explicit, never a side effect of ordinary editing.
  completed: ['open', 'in_progress'],
  cancelled: ['open'],
};

export function canTransitionStatus(from: QuestStatus, to: QuestStatus): boolean {
  if (from === to) return true;
  return STATUS_TRANSITIONS[from].includes(to);
}
