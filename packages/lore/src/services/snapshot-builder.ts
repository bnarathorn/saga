import type { MemoryCategory } from '@saga/contracts';
import { estimateTokens, truncateToTokens } from '@saga/shared';
import type { ContextSection, ContextSectionEntry, MemoryItemWithVersion } from '../domain/lore.js';

/**
 * Core-context section order (spec 8.7). Warnings are ranked first among the *reserved*
 * sections so that trimming can never drop a hazard in favour of a nicety.
 */
export interface SectionSpec {
  id: string;
  title: string;
  categories: readonly MemoryCategory[];
  /**
   * Fraction of the budget guaranteed to this section before anything is allocated
   * proportionally. Warnings and critical operating constraints hold a reserve.
   */
  reserve: number;
}

export const CORE_SECTIONS: readonly SectionSpec[] = [
  { id: 'overview', title: 'Project Overview', categories: ['overview'], reserve: 0.14 },
  { id: 'structure', title: 'Structure', categories: ['structure'], reserve: 0.14 },
  {
    id: 'conventions',
    title: 'Critical Coding Conventions',
    categories: ['coding_style'],
    reserve: 0.14,
  },
  { id: 'running', title: 'Running Locally', categories: ['running', 'config'], reserve: 0.14 },
  { id: 'testing', title: 'Testing', categories: ['testing'], reserve: 0.1 },
  {
    id: 'operations',
    title: 'Deployment and Operations',
    categories: ['deploy', 'logs', 'debug'],
    reserve: 0.1,
  },
  { id: 'warnings', title: 'Important Warnings', categories: ['warning'], reserve: 0.14 },
];

export const TASK_SECTIONS: readonly SectionSpec[] = [
  { id: 'warnings', title: 'Relevant Warnings', categories: ['warning'], reserve: 0.2 },
  {
    id: 'components',
    title: 'Relevant Components',
    categories: ['structure', 'server', 'database', 'api'],
    reserve: 0.25,
  },
  { id: 'conventions', title: 'Relevant Conventions', categories: ['coding_style'], reserve: 0.15 },
  { id: 'config', title: 'Configuration', categories: ['config', 'running'], reserve: 0.15 },
  {
    id: 'procedures',
    title: 'Debugging, Logging and Testing',
    categories: ['debug', 'logs', 'testing', 'deploy'],
    reserve: 0.15,
  },
  { id: 'decisions', title: 'Decisions', categories: ['decision'], reserve: 0.1 },
];

const VERIFICATION_RANK = { verified: 0, observed: 1, inferred: 2 } as const;

/**
 * Deterministic ordering within a section:
 *   importance desc, verification rank asc, recency desc, memory key asc.
 * The final key makes the order total, so the same inputs always render byte-identically.
 */
export function orderEntries(items: readonly MemoryItemWithVersion[]): MemoryItemWithVersion[] {
  return [...items].sort((a, b) => {
    if (a.importance !== b.importance) return b.importance - a.importance;
    const rankA = VERIFICATION_RANK[a.currentVersion?.verificationState ?? 'inferred'];
    const rankB = VERIFICATION_RANK[b.currentVersion?.verificationState ?? 'inferred'];
    if (rankA !== rankB) return rankA - rankB;
    const timeA = a.currentVersion?.createdAt.getTime() ?? 0;
    const timeB = b.currentVersion?.createdAt.getTime() ?? 0;
    if (timeA !== timeB) return timeB - timeA;
    return a.memoryKey < b.memoryKey ? -1 : a.memoryKey > b.memoryKey ? 1 : 0;
  });
}

export interface BuildSectionsInput {
  items: readonly MemoryItemWithVersion[];
  specs: readonly SectionSpec[];
  tokenBudget: number;
  /** Stale entries are excluded from ordinary core context unless explicitly allowed. */
  includeStale?: boolean;
}

export interface BuiltContext {
  sections: ContextSection[];
  rendered: string;
  tokenCount: number;
  /** Entries dropped because the budget ran out, so callers can report the omission. */
  omitted: string[];
}

/**
 * Compose sections within a token budget.
 *
 * Allocation is two-pass: every section first receives its reserve, then leftover budget is
 * distributed to sections that still have entries, in spec order. A section never borrows
 * from a section ranked above it, which is what guarantees that warnings survive trimming.
 */
export function buildSections(input: BuildSectionsInput): BuiltContext {
  const includeStale = input.includeStale ?? false;
  const usable = input.items.filter(
    (item) =>
      item.currentVersion !== null &&
      item.state !== 'archived' &&
      (includeStale || item.state !== 'stale'),
  );

  const grouped = new Map<string, MemoryItemWithVersion[]>();
  const claimed = new Set<string>();
  for (const spec of input.specs) {
    const matching = orderEntries(
      usable.filter((item) => !claimed.has(item.id) && spec.categories.includes(item.category)),
    );
    for (const item of matching) claimed.add(item.id);
    grouped.set(spec.id, matching);
  }

  const activeSpecs = input.specs.filter((spec) => (grouped.get(spec.id) ?? []).length > 0);
  const allocations = allocateBudget(activeSpecs, input.tokenBudget);

  const sections: ContextSection[] = [];
  const omitted: string[] = [];

  for (const spec of activeSpecs) {
    const budget = allocations.get(spec.id) ?? 0;
    const entries: ContextSectionEntry[] = [];
    let used = 0;

    for (const item of grouped.get(spec.id) ?? []) {
      const version = item.currentVersion!;
      const cost = estimateTokens(`### ${item.memoryKey}\n${version.body}\n`);
      if (used + cost > budget) {
        // The first entry of a section is always included, truncated if necessary, so a
        // section never renders as an empty heading.
        if (entries.length === 0 && budget > 0) {
          entries.push({
            memoryKey: item.memoryKey,
            body: truncateToTokens(version.body, Math.max(1, budget - 8)),
            state: item.state,
            verificationState: version.verificationState,
            staleReason: item.staleReason,
          });
          used = budget;
          continue;
        }
        omitted.push(item.memoryKey);
        continue;
      }
      entries.push({
        memoryKey: item.memoryKey,
        body: version.body,
        state: item.state,
        verificationState: version.verificationState,
        staleReason: item.staleReason,
      });
      used += cost;
    }

    if (entries.length > 0) sections.push({ id: spec.id, title: spec.title, entries });
  }

  const rendered = renderSections(sections);
  return { sections, rendered, tokenCount: estimateTokens(rendered), omitted };
}

function allocateBudget(specs: readonly SectionSpec[], budget: number): Map<string, number> {
  const allocations = new Map<string, number>();
  if (specs.length === 0 || budget <= 0) return allocations;

  const totalReserve = specs.reduce((sum, spec) => sum + spec.reserve, 0);
  let remaining = budget;

  for (const spec of specs) {
    // Normalise reserves so a subset of sections still consumes the whole budget.
    const share = Math.floor((budget * spec.reserve) / Math.max(totalReserve, 0.0001));
    allocations.set(spec.id, share);
    remaining -= share;
  }

  // Hand any rounding remainder to the highest-ranked section.
  if (remaining > 0 && specs[0] !== undefined) {
    allocations.set(specs[0].id, (allocations.get(specs[0].id) ?? 0) + remaining);
  }
  return allocations;
}

export function renderSections(sections: readonly ContextSection[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    parts.push(`## ${section.title}`);
    for (const entry of section.entries) {
      const labels: string[] = [];
      if (entry.state === 'stale') {
        labels.push(`STALE — ${entry.staleReason ?? 'reason not recorded'}`);
      }
      if (entry.verificationState === 'inferred') labels.push('inferred, not verified');
      const suffix = labels.length === 0 ? '' : ` _(${labels.join('; ')})_`;
      parts.push(`### ${entry.memoryKey}${suffix}`);
      parts.push(entry.body.trim());
    }
  }
  return parts.join('\n\n');
}
