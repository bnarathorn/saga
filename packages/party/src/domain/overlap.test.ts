import { describe, expect, it } from 'vitest';
import {
  detectOverlaps,
  renderPartyContext,
  sanitizeWorkspaceLabel,
  type AgentSnapshot,
} from './overlap.js';

function agent(overrides: Partial<AgentSnapshot> & { agentRunId: string }): AgentSnapshot {
  return {
    sessionId: `session-${overrides.agentRunId}`,
    client: 'codex',
    workspaceKey: null,
    workItemId: `quest-${overrides.agentRunId}`,
    questTitle: 'Some Quest',
    scope: {},
    claims: [],
    changedFiles: [],
    ...overrides,
  };
}

describe('overlap detection', () => {
  it('reports nothing when scopes are disjoint', () => {
    const subject = agent({ agentRunId: 'a', scope: { modules: ['api'] } });
    const peer = agent({ agentRunId: 'b', scope: { modules: ['web'] } });
    expect(detectOverlaps(subject, [peer])).toEqual([]);
  });

  it('reports a shared module as a warning', () => {
    const subject = agent({ agentRunId: 'a', scope: { modules: ['services/api/src/auth'] } });
    const peer = agent({
      agentRunId: 'b',
      client: 'claude-code',
      questTitle: 'Token rotation',
      scope: { modules: ['services/api/src/auth'] },
    });

    const overlaps = detectOverlaps(subject, [peer]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      kind: 'module',
      severity: 'warning',
      other_quest_title: 'Token rotation',
      values: ['services/api/src/auth'],
    });
  });

  it('escalates to critical when both agents share a workspace', () => {
    // Uncommitted changes are immediately visible to both, so this is a live hazard.
    const subject = agent({
      agentRunId: 'a',
      workspaceKey: 'machine-a:erp',
      scope: { modules: ['api'] },
    });
    const peer = agent({
      agentRunId: 'b',
      workspaceKey: 'machine-a:erp',
      scope: { modules: ['api'] },
    });

    const overlaps = detectOverlaps(subject, [peer]);
    expect(overlaps[0]?.kind).toBe('workspace');
    expect(overlaps[0]?.severity).toBe('critical');
    expect(overlaps.find((o) => o.kind === 'module')?.severity).toBe('critical');
  });

  it('does not treat separate working copies as a workspace overlap', () => {
    const subject = agent({ agentRunId: 'a', workspaceKey: 'machine-a:erp-main' });
    const peer = agent({ agentRunId: 'b', workspaceKey: 'machine-b:erp-copy-2' });
    expect(detectOverlaps(subject, [peer])).toEqual([]);
  });

  it('reports changed-file collisions as critical', () => {
    const subject = agent({ agentRunId: 'a', changedFiles: ['src/auth/refresh.ts'] });
    const peer = agent({ agentRunId: 'b', changedFiles: ['src/auth/refresh.ts', 'src/other.ts'] });

    const overlaps = detectOverlaps(subject, [peer]);
    expect(overlaps[0]).toMatchObject({
      kind: 'file',
      severity: 'critical',
      values: ['src/auth/refresh.ts'],
    });
  });

  it('reports a claim on the same resource', () => {
    const claim = {
      resourceType: 'test_environment',
      resourceKey: 'integration-db',
      mode: 'exclusive',
    };
    const overlaps = detectOverlaps(agent({ agentRunId: 'a', claims: [claim] }), [
      agent({ agentRunId: 'b', claims: [claim] }),
    ]);
    expect(overlaps[0]?.kind).toBe('claim');
    expect(overlaps[0]?.values).toEqual(['test_environment:integration-db']);
  });

  it('ignores two agent runs serving the same Quest', () => {
    const subject = agent({ agentRunId: 'a', workItemId: 'quest-1', scope: { modules: ['api'] } });
    const peer = agent({ agentRunId: 'b', workItemId: 'quest-1', scope: { modules: ['api'] } });
    expect(detectOverlaps(subject, [peer])).toEqual([]);
  });

  it('ignores the agent itself', () => {
    const subject = agent({ agentRunId: 'a', scope: { modules: ['api'] } });
    expect(detectOverlaps(subject, [subject])).toEqual([]);
  });

  it('orders the most severe overlap first and is deterministic', () => {
    const subject = agent({
      agentRunId: 'a',
      scope: { modules: ['api'], components: ['auth'] },
      changedFiles: ['x.ts'],
    });
    const peers = [
      agent({ agentRunId: 'c', scope: { components: ['auth'] } }),
      agent({ agentRunId: 'b', changedFiles: ['x.ts'] }),
    ];
    const first = detectOverlaps(subject, peers);
    const second = detectOverlaps(subject, [...peers].reverse());
    expect(first).toEqual(second);
    expect(first[0]?.severity).toBe('critical');
  });

  it('caps the values it reports so context stays small', () => {
    const many = Array.from({ length: 50 }, (_, index) => `file-${index}.ts`);
    const overlaps = detectOverlaps(agent({ agentRunId: 'a', changedFiles: many }), [
      agent({ agentRunId: 'b', changedFiles: many }),
    ]);
    expect(overlaps[0]?.values.length).toBeLessThanOrEqual(10);
  });
});

describe('party context rendering', () => {
  it('renders nothing when the agent is alone', () => {
    expect(renderPartyContext([], [], [])).toBe('');
  });

  it('renders parallel work, warnings and claims concisely', () => {
    const peer = agent({
      agentRunId: 'b',
      client: 'Codex',
      questTitle: 'Implement report API endpoint',
      scope: { modules: ['services/api/src/reports'], apis: ['/v1/reports/export'] },
      claims: [
        { resourceType: 'migration_sequence', resourceKey: 'db/migrations', mode: 'exclusive' },
      ],
    });
    const rendered = renderPartyContext(
      [peer],
      detectOverlaps(agent({ agentRunId: 'a', scope: { modules: ['services/api/src/reports'] } }), [
        peer,
      ]),
      [
        {
          resourceType: 'test_environment',
          resourceKey: 'integration-test-db',
          mode: 'exclusive',
          questTitle: 'Add token-family migration',
          leaseExpiresAt: new Date('2026-03-01T14:32:00Z'),
        },
      ],
    );

    expect(rendered).toContain('## Parallel work');
    expect(rendered).toContain('Codex: Implement report API endpoint');
    expect(rendered).toContain('services/api/src/reports');
    expect(rendered).toContain('## Overlap warnings');
    expect(rendered).toContain('## Claims');
    expect(rendered).toContain('integration-test-db');
    expect(rendered).toContain('2026-03-01T14:32:00.000Z');
  });

  it('does not inject every peer checkpoint', () => {
    const peer = agent({ agentRunId: 'b', questTitle: 'Other work' });
    const rendered = renderPartyContext([peer], [], []);
    expect(rendered).not.toContain('checkpoint');
    expect(rendered.split('\n').length).toBeLessThan(10);
  });
});

describe('workspace labels', () => {
  it('keeps a sanitised label', () => {
    expect(sanitizeWorkspaceLabel('machine-a:erp-main')).toBe('machine-a:erp-main');
  });

  it('never exposes an absolute path', () => {
    expect(sanitizeWorkspaceLabel('/home/alice/projects/erp-backoffice')).toBe('erp-backoffice');
    expect(sanitizeWorkspaceLabel('C:\\Users\\alice\\erp')).toBe('erp');
  });

  it('truncates a very long label', () => {
    expect(sanitizeWorkspaceLabel('x'.repeat(200))?.length).toBe(60);
  });

  it('treats blank input as absent', () => {
    expect(sanitizeWorkspaceLabel('   ')).toBeNull();
    expect(sanitizeWorkspaceLabel(null)).toBeNull();
    expect(sanitizeWorkspaceLabel(undefined)).toBeNull();
  });
});
