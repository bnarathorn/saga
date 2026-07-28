import type { BootstrapPlan, ContextRequest, ContextResponse } from '@saga/contracts';
import type { Project } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { estimateTokens, truncateToTokens } from '@saga/shared';
import type { MemoryItemWithVersion } from '../domain/lore.js';
import { type MemoryRepository } from '../repositories/memory-repository.js';
import { type SnapshotRepository } from '../repositories/snapshot-repository.js';
import type { SearchService } from './search-service.js';
import { TASK_SECTIONS, buildSections } from './snapshot-builder.js';

export interface ContextBudgets {
  core: number;
  task: number;
  continuation: number;
  party: number;
}

/**
 * Continuation and Party context are produced by the Quest and Party domains. Lore does not
 * read their tables; the application registers providers here (ADR-0001).
 */
export interface ContinuationProvider {
  (input: {
    projectId: string;
    questId: string | null;
    sessionId: string | null;
    tokenBudget: number;
  }): Promise<ContextResponse['continuation']>;
}

export interface PartyContextProvider {
  (input: {
    projectId: string;
    questId: string | null;
    sessionId: string | null;
    tokenBudget: number;
  }): Promise<{ rendered: string; data: Record<string, unknown>; warnings: string[] }>;
}

export interface ContextServiceDeps {
  pool: SagaPool;
  memory: MemoryRepository;
  snapshots: SnapshotRepository;
  search: SearchService;
  budgets: ContextBudgets;
  continuation?: ContinuationProvider;
  party?: PartyContextProvider;
}

export class ContextService {
  private continuationProvider: ContinuationProvider | undefined;
  private partyProvider: PartyContextProvider | undefined;

  constructor(private readonly deps: ContextServiceDeps) {
    this.continuationProvider = deps.continuation;
    this.partyProvider = deps.party;
  }

  /**
   * Registered by the application once Quest exists. Lore never imports Quest; it asks for
   * the continuation layer through this hook (ADR-0001).
   */
  setContinuationProvider(provider: ContinuationProvider): void {
    this.continuationProvider = provider;
  }

  setPartyProvider(provider: PartyContextProvider): void {
    this.partyProvider = provider;
  }

  /**
   * Compose the three layers (spec 8.6).
   *
   *   Layer 1 Core          the compiled snapshot, always sent at session startup
   *   Layer 2 Task          selected after the first task, from Lore search
   *   Layer 3 Continuation  only for `resume_work`
   *
   * Party context rides alongside as a fourth, optional budget.
   */
  async compose(project: Project, request: ContextRequest): Promise<ContextResponse> {
    const budgets = this.scaleBudgets(request.token_budget);
    const warnings: string[] = [];

    const snapshot = await this.deps.snapshots.findActive(this.deps.pool, project.id);
    const bootstrapRequired = snapshot === null;
    if (bootstrapRequired) {
      warnings.push(
        'This project has no active core context yet. Propose initial Lore from local evidence before relying on Saga for project knowledge.',
      );
    }

    const coreContext = snapshot?.renderedContext ?? '';

    let taskContext: string | null = null;
    if (
      request.task !== undefined &&
      request.task.trim().length > 0 &&
      request.mode !== 'inquiry'
    ) {
      taskContext = await this.buildTaskContext(project, request.task, budgets.task, warnings);
    } else if (request.task !== undefined && request.mode === 'inquiry') {
      // Inquiry sessions still benefit from relevant knowledge; they simply create no Quest.
      taskContext = await this.buildTaskContext(project, request.task, budgets.task, warnings);
    }

    let continuation: ContextResponse['continuation'] = null;
    if (request.mode === 'resume_work' && this.continuationProvider !== undefined) {
      continuation = await this.continuationProvider({
        projectId: project.id,
        questId: request.quest_id ?? null,
        sessionId: request.session_id ?? null,
        tokenBudget: budgets.continuation,
      });
      if (continuation !== null && continuation.recovered_from_interrupted_session) {
        warnings.push(
          'The previous session ended without a final handoff. This continuation was recovered from its latest checkpoint.',
        );
      }
    }

    let party: Record<string, unknown> = {};
    let partyTokens = 0;
    if (this.partyProvider !== undefined) {
      const result = await this.partyProvider({
        projectId: project.id,
        questId: request.quest_id ?? null,
        sessionId: request.session_id ?? null,
        tokenBudget: budgets.party,
      });
      party = result.data;
      partyTokens = estimateTokens(result.rendered);
      warnings.push(...result.warnings);
    }

    const staleCount = await this.countStale(project.id);
    if (staleCount > 0) {
      warnings.push(
        `${staleCount} Lore ${staleCount === 1 ? 'Entry is' : 'Entries are'} marked stale and excluded from core context. Re-verify them when convenient.`,
      );
    }

    return {
      project: { id: project.id, name: project.name, memory_revision: project.memoryRevision },
      mode: request.mode ?? null,
      core_context: coreContext,
      task_context: taskContext,
      continuation,
      party,
      warnings,
      bootstrap_required: bootstrapRequired,
      token_counts: {
        core: estimateTokens(coreContext),
        task: taskContext === null ? 0 : estimateTokens(taskContext),
        continuation: continuation === null ? 0 : estimateTokens(continuation.rendered),
        party: partyTokens,
      },
    };
  }

  /** Task context is Lore search results rendered into the same section shape as core. */
  private async buildTaskContext(
    project: Project,
    task: string,
    budget: number,
    warnings: string[],
  ): Promise<string> {
    const results = await this.deps.search.search(project, {
      query: task,
      limit: 24,
      relation_depth: 1,
      filters: { states: ['active', 'stale'] },
    });
    warnings.push(...results.warnings);
    if (results.hits.length === 0) return '';

    const ids = results.hits.map((hit) => hit.memory_item_id);
    const all = await this.deps.memory.listItems(this.deps.pool, {
      projectId: project.id,
      limit: 5_000,
    });
    const wanted = new Set(ids);
    // Preserve search relevance order inside each section by re-importancing the hits:
    // a highly relevant entry should not fall behind a merely important one here.
    const relevance = new Map(ids.map((id, index) => [id, ids.length - index]));
    const items: MemoryItemWithVersion[] = all
      .filter((item) => wanted.has(item.id))
      .map((item) => ({
        ...item,
        importance: Math.min(
          100,
          Math.round((relevance.get(item.id) ?? 0) * (100 / Math.max(1, ids.length))),
        ),
      }));

    const built = buildSections({
      items,
      specs: TASK_SECTIONS,
      tokenBudget: budget,
      includeStale: true,
    });
    if (built.omitted.length > 0) {
      warnings.push(
        `${built.omitted.length} relevant Lore ${built.omitted.length === 1 ? 'Entry was' : 'Entries were'} omitted from task context to stay inside the token budget.`,
      );
    }
    return truncateToTokens(built.rendered, budget);
  }

  private async countStale(projectId: string): Promise<number> {
    const counts = await this.deps.memory.countsForProjects(this.deps.pool, [projectId]);
    return counts.get(projectId)?.stale ?? 0;
  }

  /** Scale the configured budgets proportionally when a caller supplies a total. */
  private scaleBudgets(total: number | undefined): ContextBudgets {
    const base = this.deps.budgets;
    if (total === undefined) return base;
    const configuredTotal = base.core + base.task + base.continuation + base.party;
    const ratio = total / Math.max(1, configuredTotal);
    return {
      core: Math.max(200, Math.floor(base.core * ratio)),
      task: Math.max(200, Math.floor(base.task * ratio)),
      continuation: Math.max(100, Math.floor(base.continuation * ratio)),
      party: Math.max(50, Math.floor(base.party * ratio)),
    };
  }
}

/**
 * Guidance returned when a project has no active context snapshot. The server never reads the
 * user's source tree; this tells the CLI or agent what is worth inspecting locally.
 */
export function bootstrapPlan(required: boolean): BootstrapPlan {
  return {
    required,
    reason: required
      ? 'This project has no active core context snapshot yet.'
      : 'Core context is already compiled.',
    inspect_paths: [
      'README*',
      'docs/**',
      'package.json',
      'pnpm-workspace.yaml',
      'pyproject.toml',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
      'build.gradle*',
      'composer.json',
      'Gemfile',
      'Dockerfile*',
      'docker-compose*.yml',
      '.github/workflows/**',
      '.gitlab-ci.yml',
      'Makefile',
      'justfile',
      '.env.example',
      'openapi.*',
      'db/migrations/**',
      'migrations/**',
      'tsconfig*.json',
      '.eslintrc*',
      'eslint.config.*',
      '.prettierrc*',
      'vitest.config.*',
      'jest.config.*',
      'pytest.ini',
    ],
    exclude_paths: [
      'node_modules/**',
      '.git/**',
      '.svn/**',
      'dist/**',
      'build/**',
      'target/**',
      'vendor/**',
      '.env',
      '.env.*',
      '**/*.pem',
      '**/*.key',
      '**/*.p12',
      '**/id_rsa*',
      '**/secrets*',
      '**/credentials*',
    ],
    proposed_keys: [
      {
        memory_key: 'project.overview',
        category: 'overview',
        kind: 'fact',
        guidance: 'What this project is and who uses it, in a few sentences. Cite the README.',
      },
      {
        memory_key: 'structure.top_level',
        category: 'structure',
        kind: 'map',
        guidance: 'The top-level layout and what each directory is for.',
      },
      {
        memory_key: 'style.<language>',
        category: 'coding_style',
        kind: 'convention',
        guidance:
          'Conventions actually enforced by the linter or formatter configuration. Do not invent house style.',
      },
      {
        memory_key: 'config.local',
        category: 'config',
        kind: 'fact',
        guidance:
          'Which environment variables are required locally, taken from .env.example. Never record their values.',
      },
      {
        memory_key: 'run.local',
        category: 'running',
        kind: 'procedure',
        guidance: 'The exact commands that start the project locally, taken from scripts.',
      },
      {
        memory_key: 'testing.default',
        category: 'testing',
        kind: 'procedure',
        guidance: 'How tests are run and what infrastructure they need.',
      },
      {
        memory_key: 'deploy.<environment>',
        category: 'deploy',
        kind: 'procedure',
        guidance: 'Only if a deployment file or workflow actually exists. Never infer a procedure.',
      },
      {
        memory_key: 'database.<name>',
        category: 'database',
        kind: 'entity',
        guidance: 'Engine, migration conventions and operational constraints, from real evidence.',
      },
      {
        memory_key: 'api.<name>',
        category: 'api',
        kind: 'entity',
        guidance: 'Only from an OpenAPI document, route definitions or equivalent evidence.',
      },
    ],
    rules: [
      'Never invent a command, endpoint, server, database or deployment procedure.',
      'Mark anything you concluded rather than read as verification_state = "inferred", with lower confidence.',
      'Include the evidence path and content hash for every entry you can.',
      'Do not read excluded files or anything that looks like a secret.',
      'Split long knowledge into several Lore Entries rather than one long document.',
    ],
  };
}
