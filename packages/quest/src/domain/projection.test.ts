import type { QuestStatus } from '@saga/contracts';
import { describe, expect, it } from 'vitest';
import {
  canTransitionStatus,
  projectParentStatus,
  wouldCreateCycle,
  type ChildState,
} from './projection.js';

const children = (...statuses: QuestStatus[]): ChildState[] =>
  statuses.map((status) => ({ status }));

function project(current: QuestStatus, kids: ChildState[], manual = false) {
  return projectParentStatus({
    currentParentStatus: current,
    parentStatusSetManually: manual,
    children: kids,
  });
}

describe('parent-state projection', () => {
  it('completes when every non-cancelled child is completed', () => {
    expect(project('in_progress', children('completed', 'completed')).status).toBe('completed');
    expect(project('in_progress', children('completed', 'cancelled')).status).toBe('completed');
  });

  it('is in progress when any child is', () => {
    expect(project('open', children('completed', 'in_progress', 'blocked')).status).toBe(
      'in_progress',
    );
  });

  it('is blocked when a child is blocked and none is in progress', () => {
    expect(project('open', children('blocked', 'open')).status).toBe('blocked');
    // A child in progress outranks a blocked sibling: work is still moving.
    expect(project('open', children('blocked', 'in_progress')).status).toBe('in_progress');
  });

  it('waits only when every active child is waiting', () => {
    expect(project('open', children('waiting', 'waiting', 'completed')).status).toBe('waiting');
    expect(project('open', children('waiting', 'open')).status).toBe('open');
  });

  it('is open otherwise', () => {
    expect(project('waiting', children('open', 'open')).status).toBe('open');
  });

  it('cancels when every child was cancelled', () => {
    expect(project('open', children('cancelled', 'cancelled')).status).toBe('cancelled');
  });

  it('never overwrites an explicitly cancelled parent', () => {
    const result = project('cancelled', children('in_progress'));
    expect(result.status).toBe('cancelled');
    expect(result.changed).toBe(false);
  });

  it('never overwrites a manually set parent status', () => {
    const result = project('blocked', children('completed', 'completed'), true);
    expect(result.status).toBe('blocked');
    expect(result.changed).toBe(false);
    expect(result.reason).toContain('set manually');
  });

  it('leaves a childless Quest alone', () => {
    const result = project('open', []);
    expect(result.changed).toBe(false);
    expect(result.reason).toContain('no children');
  });

  it('reports whether the status actually changed', () => {
    expect(project('in_progress', children('in_progress')).changed).toBe(false);
    expect(project('open', children('in_progress')).changed).toBe(true);
  });

  it('is deterministic regardless of child order', () => {
    const a = project('open', children('waiting', 'blocked', 'completed'));
    const b = project('open', children('completed', 'blocked', 'waiting'));
    expect(a.status).toBe(b.status);
  });
});

describe('cycle detection', () => {
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ];

  it('rejects a self edge', () => {
    expect(wouldCreateCycle(edges, 'a', 'a')).toBe(true);
  });

  it('detects a direct cycle', () => {
    expect(wouldCreateCycle(edges, 'b', 'a')).toBe(true);
  });

  it('detects a transitive cycle', () => {
    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true);
  });

  it('allows an edge that keeps the graph acyclic', () => {
    expect(wouldCreateCycle(edges, 'c', 'd')).toBe(false);
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(false); // a diamond is not a cycle
  });

  it('terminates on a graph that already contains a cycle', () => {
    const cyclic = [
      { from: 'x', to: 'y' },
      { from: 'y', to: 'x' },
    ];
    expect(wouldCreateCycle(cyclic, 'z', 'x')).toBe(false);
    expect(wouldCreateCycle(cyclic, 'x', 'z')).toBe(false);
  });

  it('handles an empty graph', () => {
    expect(wouldCreateCycle([], 'a', 'b')).toBe(false);
  });
});

describe('status transitions', () => {
  it('allows the ordinary lifecycle moves', () => {
    expect(canTransitionStatus('open', 'in_progress')).toBe(true);
    expect(canTransitionStatus('in_progress', 'blocked')).toBe(true);
    expect(canTransitionStatus('blocked', 'completed')).toBe(true);
  });

  it('treats a no-op transition as allowed', () => {
    expect(canTransitionStatus('completed', 'completed')).toBe(true);
  });

  it('only permits reopening a completed Quest to an active state', () => {
    expect(canTransitionStatus('completed', 'in_progress')).toBe(true);
    expect(canTransitionStatus('completed', 'blocked')).toBe(false);
    expect(canTransitionStatus('completed', 'cancelled')).toBe(false);
  });

  it('only permits restoring a cancelled Quest to open', () => {
    expect(canTransitionStatus('cancelled', 'open')).toBe(true);
    expect(canTransitionStatus('cancelled', 'completed')).toBe(false);
  });
});
