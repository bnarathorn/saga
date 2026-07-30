import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_SCOPES, PERMISSIONS, type AgentScope, type Permission } from '@saga/contracts';
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, permissionsFor, type AgentActor } from './authorization.js';

/**
 * Spec 22.3-style guard: `docs/security.md` §3 restates the authorization matrix in prose for
 * humans. That restatement has drifted from the code before (a row granting `shrine:read` to an
 * agent scope that `SCOPE_PERMISSIONS` deliberately withholds, and a missing `shrine:health`
 * row) and nothing caught it because the table isn't derived from anything — it's just typed
 * out by hand. This test parses the table and asserts it matches `ROLE_PERMISSIONS` and
 * `permissionsFor` exactly, so a future edit to either side without the other fails CI.
 */

const DOCS_PATH = join(__dirname, '../../../../docs/security.md');

const CHECK = '✓'; // ✓
const DASH = '—'; // —

interface DocRow {
  permission: string;
  viewer: boolean;
  operator: boolean;
  admin: boolean;
  agentScopes: string[];
}

function parseSecurityDocTable(markdown: string): DocRow[] {
  const rows: DocRow[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1) // drop the empty strings before the first and after the last `|`
      .map((cell) => cell.trim());
    if (cells.length !== 5) continue;
    const [permissionCell, viewerCell, operatorCell, adminCell, scopeCell] = cells;
    if (!permissionCell?.startsWith('`')) continue; // header row and separator row, skipped

    const permission = permissionCell.replace(/`/g, '');
    const toBool = (cell: string | undefined) => {
      if (cell === CHECK) return true;
      if (cell === '') return false;
      throw new Error(`docs/security.md: unrecognized cell "${cell}" for \`${permission}\``);
    };
    const agentScopes =
      scopeCell === DASH || scopeCell === ''
        ? []
        : (scopeCell ?? '')
            .split(',')
            .map((s) => s.trim().replace(/`/g, ''))
            .filter(Boolean);

    rows.push({
      permission,
      viewer: toBool(viewerCell),
      operator: toBool(operatorCell),
      admin: toBool(adminCell),
      agentScopes,
    });
  }
  return rows;
}

function agent(scopes: AgentScope[]): AgentActor {
  return {
    type: 'agent',
    tokenId: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000010',
    name: 'doc-check agent',
    scopes,
  };
}

/** The actual scopes (from the code) that grant a given permission to an agent. */
function scopesGranting(permission: Permission): AgentScope[] {
  return AGENT_SCOPES.filter((scope) => permissionsFor(agent([scope])).has(permission));
}

describe('docs/security.md §3 matches the authorization code', () => {
  const markdown = readFileSync(DOCS_PATH, 'utf8');
  const rows = parseSecurityDocTable(markdown);

  it('actually parsed a row for every declared permission', () => {
    // The point of this test is to fail loudly, not silently pass because the parser matched
    // nothing (e.g. a table-format change breaking the `|` split, or a `?? []` swallowing a
    // missing property). If this assertion fails, fix the parser before trusting anything below.
    expect(rows.length).toBe(PERMISSIONS.length);
    const parsedNames = rows.map((r) => r.permission).sort();
    expect(parsedNames).toEqual([...PERMISSIONS].sort());
  });

  it.each(PERMISSIONS)('`%s` has a doc row matching the code', (permission) => {
    const row = rows.find((r) => r.permission === permission);
    expect(row, `docs/security.md is missing a row for \`${permission}\``).toBeDefined();
    if (!row) return;

    const expected = {
      viewer: ROLE_PERMISSIONS.viewer.includes(permission),
      operator: ROLE_PERMISSIONS.operator.includes(permission),
      admin: ROLE_PERMISSIONS.admin.includes(permission),
      agentScopes: scopesGranting(permission).slice().sort(),
    };
    const actual = {
      viewer: row.viewer,
      operator: row.operator,
      admin: row.admin,
      agentScopes: row.agentScopes.slice().sort(),
    };

    expect(
      actual,
      `docs/security.md row for \`${permission}\` is ${JSON.stringify(actual)} but the code says ${JSON.stringify(expected)}`,
    ).toEqual(expected);
  });
});
