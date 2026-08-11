import { MEMORY_CATEGORIES } from '@saga/contracts';
import { estimateTokens } from '@saga/shared';
import { describe, expect, it } from 'vitest';
import type { MemoryItemWithVersion } from '../domain/lore.js';
import { CORE_SECTIONS, buildSections, orderEntries, renderSections } from './snapshot-builder.js';

let counter = 0;

function entry(
  overrides: Partial<MemoryItemWithVersion> & { memoryKey: string },
): MemoryItemWithVersion {
  counter += 1;
  const created = new Date('2026-01-01T00:00:00Z');
  return {
    id: `item-${String(counter).padStart(3, '0')}`,
    projectId: 'project-1',
    memoryKey: overrides.memoryKey,
    category: overrides.category ?? 'overview',
    kind: overrides.kind ?? 'fact',
    state: overrides.state ?? 'active',
    importance: overrides.importance ?? 50,
    volatility: overrides.volatility ?? 'stable',
    currentVersionId: 'version-1',
    lastVerifiedAt: null,
    staleReason: overrides.staleReason ?? null,
    createdAt: created,
    updatedAt: created,
    currentVersion: {
      id: `version-${counter}`,
      memoryItemId: `item-${counter}`,
      memoryUpdateId: null,
      baseVersionId: null,
      body: overrides.currentVersion?.body ?? `Body for ${overrides.memoryKey}.`,
      data: {},
      evidence: [],
      contentHash: 'sha256:x',
      confidence: 0.9,
      verificationState: overrides.currentVersion?.verificationState ?? 'observed',
      embeddingState: 'ready',
      embeddingModel: 'fake',
      createdBySessionId: null,
      createdAt: overrides.currentVersion?.createdAt ?? created,
      readyAt: created,
    },
    ...('state' in overrides ? { state: overrides.state! } : {}),
  };
}

describe('entry ordering', () => {
  it('ranks by importance, then verification, then recency, then key', () => {
    const items = [
      entry({ memoryKey: 'b.low', importance: 10 }),
      entry({ memoryKey: 'a.high', importance: 90 }),
      entry({ memoryKey: 'c.high', importance: 90 }),
    ];
    expect(orderEntries(items).map((item) => item.memoryKey)).toEqual([
      'a.high',
      'c.high',
      'b.low',
    ]);
  });

  it('prefers verified over inferred at equal importance', () => {
    const items = [
      entry({
        memoryKey: 'a.inferred',
        currentVersion: { verificationState: 'inferred' } as never,
      }),
      entry({
        memoryKey: 'b.verified',
        currentVersion: { verificationState: 'verified' } as never,
      }),
    ];
    expect(orderEntries(items)[0]?.memoryKey).toBe('b.verified');
  });

  it('is a total order, so repeated runs agree', () => {
    const items = [entry({ memoryKey: 'z' }), entry({ memoryKey: 'a' }), entry({ memoryKey: 'm' })];
    expect(orderEntries(items).map((i) => i.memoryKey)).toEqual(
      orderEntries([...items].reverse()).map((i) => i.memoryKey),
    );
  });
});

describe('section building', () => {
  const items = [
    entry({ memoryKey: 'project.overview', category: 'overview', importance: 95 }),
    entry({ memoryKey: 'structure.backend', category: 'structure', importance: 80 }),
    entry({ memoryKey: 'style.typescript', category: 'coding_style', importance: 70 }),
    entry({ memoryKey: 'run.api.local', category: 'running', importance: 85 }),
    entry({ memoryKey: 'testing.integration', category: 'testing', importance: 60 }),
    entry({ memoryKey: 'warning.migrations', category: 'warning', importance: 100 }),
  ];

  it('produces sections in the documented order', () => {
    const built = buildSections({ items, specs: CORE_SECTIONS, tokenBudget: 3_500 });
    expect(built.sections.map((section) => section.id)).toEqual([
      'overview',
      'structure',
      'conventions',
      'running',
      'testing',
      'warnings',
    ]);
  });

  it('gives every memory category a home, so none is dropped silently', () => {
    const oneOfEach = MEMORY_CATEGORIES.map((category) =>
      entry({ memoryKey: `${category}.probe`, category }),
    );
    const built = buildSections({ items: oneOfEach, specs: CORE_SECTIONS, tokenBudget: 20_000 });
    const placed = built.sections.flatMap((section) =>
      section.entries.map((sectionEntry) => sectionEntry.memoryKey),
    );

    // A category no section claims is filtered out before allocation: it never reaches `omitted`
    // either, so the snapshot renders short with nothing to show for the missing entry.
    expect(placed.toSorted()).toEqual(MEMORY_CATEGORIES.map((c) => `${c}.probe`).toSorted());
    expect(built.omitted).toEqual([]);
  });

  it('is deterministic: identical inputs render byte-identically', () => {
    const first = buildSections({ items, specs: CORE_SECTIONS, tokenBudget: 3_500 });
    const second = buildSections({
      items: [...items].reverse(),
      specs: CORE_SECTIONS,
      tokenBudget: 3_500,
    });
    expect(first.rendered).toBe(second.rendered);
    expect(first.tokenCount).toBe(second.tokenCount);
  });

  it('stays inside the token budget', () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      entry({
        memoryKey: `structure.module-${String(index).padStart(3, '0')}`,
        category: 'structure',
        currentVersion: { body: 'x'.repeat(600) } as never,
      }),
    );
    const built = buildSections({ items: many, specs: CORE_SECTIONS, tokenBudget: 1_000 });
    expect(built.tokenCount).toBeLessThanOrEqual(1_100); // headings add a small overhead
    expect(built.omitted.length).toBeGreaterThan(0);
  });

  it('never drops the warnings section in favour of lower-value content', () => {
    const noisy = [
      ...Array.from({ length: 100 }, (_, index) =>
        entry({
          memoryKey: `structure.module-${String(index).padStart(3, '0')}`,
          category: 'structure',
          importance: 100,
          currentVersion: { body: 'y'.repeat(800) } as never,
        }),
      ),
      entry({
        memoryKey: 'warning.destructive-migration',
        category: 'warning',
        importance: 1,
        currentVersion: {
          body: 'Never run the destructive migration against production.',
        } as never,
      }),
    ];
    const built = buildSections({ items: noisy, specs: CORE_SECTIONS, tokenBudget: 800 });
    expect(built.rendered).toContain('warning.destructive-migration');
    expect(built.sections.some((section) => section.id === 'warnings')).toBe(true);
  });

  it('excludes stale entries from ordinary core context', () => {
    const withStale = [
      ...items,
      entry({
        memoryKey: 'run.api.stale',
        category: 'running',
        state: 'stale',
        staleReason: 'the start command changed',
      }),
    ];
    const built = buildSections({ items: withStale, specs: CORE_SECTIONS, tokenBudget: 3_500 });
    expect(built.rendered).not.toContain('run.api.stale');
  });

  it('ranks a stale entry below every fresh one, whatever its importance', () => {
    // Core context carries stale entries so an agent can judge them, which is only safe while
    // they cannot displace a claim nobody doubts. Importance is deliberately the weaker key:
    // the entries an evidence check flags are usually the important ones.
    const ordered = orderEntries([
      entry({ memoryKey: 'stale.critical', importance: 92, state: 'stale', staleReason: 'moved' }),
      entry({ memoryKey: 'fresh.minor', importance: 10 }),
    ]);
    expect(ordered.map((item) => item.memoryKey)).toEqual(['fresh.minor', 'stale.critical']);
  });

  it('spends the budget on fresh entries first and trims stale ones away', () => {
    const long = 'word '.repeat(220);
    const built = buildSections({
      items: [
        entry({
          memoryKey: 'stale.important',
          category: 'running',
          importance: 95,
          state: 'stale',
          staleReason: 'moved',
          currentVersion: { body: long } as MemoryItemWithVersion['currentVersion'],
        }),
        entry({
          memoryKey: 'fresh.ordinary',
          category: 'running',
          importance: 20,
          currentVersion: { body: long } as MemoryItemWithVersion['currentVersion'],
        }),
      ],
      specs: CORE_SECTIONS,
      tokenBudget: 400,
      includeStale: true,
    });

    expect(built.rendered).toContain('fresh.ordinary');
    expect(built.rendered).not.toContain('stale.important');
    expect(built.omitted).toContain('stale.important');
  });

  it('labels a stale entry explicitly when it is included', () => {
    const withStale = [
      entry({
        memoryKey: 'run.api.stale',
        category: 'running',
        state: 'stale',
        staleReason: 'the start command changed',
      }),
    ];
    const built = buildSections({
      items: withStale,
      specs: CORE_SECTIONS,
      tokenBudget: 3_500,
      includeStale: true,
    });
    expect(built.rendered).toContain('STALE — the start command changed');
  });

  it('labels inferred knowledge so an agent does not treat it as verified', () => {
    const built = buildSections({
      items: [
        entry({
          memoryKey: 'deploy.staging',
          category: 'deploy',
          currentVersion: { verificationState: 'inferred' } as never,
        }),
      ],
      specs: CORE_SECTIONS,
      tokenBudget: 1_000,
    });
    expect(built.rendered).toContain('inferred, not verified');
  });

  it('excludes archived entries entirely', () => {
    const built = buildSections({
      items: [entry({ memoryKey: 'old.thing', category: 'overview', state: 'archived' })],
      specs: CORE_SECTIONS,
      tokenBudget: 1_000,
    });
    expect(built.sections).toEqual([]);
    expect(built.rendered).toBe('');
  });

  it('never emits an empty section heading', () => {
    const built = buildSections({
      items: [entry({ memoryKey: 'project.overview', category: 'overview' })],
      specs: CORE_SECTIONS,
      tokenBudget: 3_500,
    });
    for (const section of built.sections) expect(section.entries.length).toBeGreaterThan(0);
  });

  it('truncates rather than dropping the only entry of a section', () => {
    const built = buildSections({
      items: [
        entry({
          memoryKey: 'project.overview',
          category: 'overview',
          currentVersion: { body: 'long '.repeat(5_000) } as never,
        }),
      ],
      specs: CORE_SECTIONS,
      tokenBudget: 200,
    });
    expect(built.rendered).toContain('project.overview');
    expect(estimateTokens(built.rendered)).toBeLessThanOrEqual(260);
  });

  it('assigns each entry to exactly one section', () => {
    const built = buildSections({ items, specs: CORE_SECTIONS, tokenBudget: 5_000 });
    const keys = built.sections.flatMap((section) => section.entries.map((e) => e.memoryKey));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('renders nothing for an empty project', () => {
    const built = buildSections({ items: [], specs: CORE_SECTIONS, tokenBudget: 3_500 });
    expect(built.rendered).toBe('');
    expect(built.tokenCount).toBe(0);
  });
});

describe('rendering', () => {
  it('produces readable markdown with stable headings', () => {
    const rendered = renderSections([
      {
        id: 'overview',
        title: 'Project Overview',
        entries: [
          {
            memoryKey: 'project.overview',
            body: 'An ERP back office.',
            state: 'active',
            verificationState: 'verified',
            staleReason: null,
          },
        ],
      },
    ]);
    expect(rendered).toBe('## Project Overview\n\n### project.overview\n\nAn ERP back office.');
  });
});
