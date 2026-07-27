import type {
  EvidenceItem,
  LoreEntryInput,
  MemoryCategory,
  MemoryKind,
  MemoryState,
  MemoryUpdateState,
  VerificationState,
  Volatility,
} from '@saga/contracts';
import type { OutboxRepository, Project, ProjectRepository } from '@saga/core';
import { assertValidMemoryKey } from '@saga/core';
import type { Queryable, SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import { SagaError, buildPage, decodeCursor, type Page } from '@saga/shared';
import { contentHash } from '@saga/shared/ids';
import type { JobService } from '@saga/shrine';
import type {
  ContextSnapshot,
  MemoryItem,
  MemoryItemWithVersion,
  MemoryUpdate,
  MemoryUpdateItem,
  MemoryVersion,
} from '../domain/lore.js';
import { canTransition } from '../domain/lore.js';
import { type MemoryRepository } from '../repositories/memory-repository.js';
import { type SnapshotRepository } from '../repositories/snapshot-repository.js';
import { describeFindings, scanForSecrets } from '../secrets.js';
import { CORE_SECTIONS, buildSections } from './snapshot-builder.js';

export interface LoreServiceDeps {
  pool: SagaPool;
  memory: MemoryRepository;
  snapshots: SnapshotRepository;
  projects: ProjectRepository;
  outbox: OutboxRepository;
  jobs: JobService;
  coreContextTokens: number;
}

export interface ProposeInput {
  project: Project;
  entries: readonly LoreEntryInput[];
  summary: string;
  sessionId?: string | null;
  correlationId?: string | null;
}

export interface PublishConflict {
  memory_key: string;
  /** The version the proposer based its candidate on. */
  expected: string | null;
  /** The version the entry actually points at now. */
  actual: string | null;
}

export interface UpdateWithItems {
  update: MemoryUpdate;
  items: (MemoryUpdateItem & { candidate: MemoryVersion; conflicted: boolean })[];
}

const MAX_BODY_CHARS = 20_000;

/**
 * Owns every Lore state transition. Route handlers, worker handlers and the embedding
 * pipeline all go through this service; none of them touches `current_version_id` directly.
 */
export class LoreService {
  constructor(private readonly deps: LoreServiceDeps) {}

  // --- proposal ------------------------------------------------------------

  /**
   * Create a candidate update. This never changes what readers see: it inserts immutable
   * candidate versions and the item-level base pointers that publication will check.
   */
  async propose(input: ProposeInput): Promise<MemoryUpdate> {
    if (input.project.status === 'archived') {
      throw new SagaError(
        'PROJECT_ARCHIVED',
        `The project "${input.project.name}" is archived and is read-only.`,
      );
    }

    const seen = new Set<string>();
    for (const entry of input.entries) {
      assertValidMemoryKey(entry.memory_key);
      if (seen.has(entry.memory_key)) {
        throw new SagaError(
          'VALIDATION_FAILED',
          `The entry "${entry.memory_key}" appears more than once in this proposal. Merge it into a single entry.`,
          { details: { memory_key: entry.memory_key } },
        );
      }
      seen.add(entry.memory_key);
      assertBodySize(entry);
      assertNoSecrets(entry);
    }

    const update = await withTransaction(this.deps.pool, async (tx) => {
      const created = await this.deps.memory.createUpdate(tx, {
        projectId: input.project.id,
        summary: input.summary,
        createdBySessionId: input.sessionId ?? null,
        correlationId: input.correlationId ?? null,
      });

      for (const entry of input.entries) {
        const item = await this.deps.memory.upsertItem(tx, {
          projectId: input.project.id,
          memoryKey: entry.memory_key,
          category: entry.category,
          kind: entry.kind,
          importance: entry.importance ?? defaultImportance(entry.category),
          volatility: entry.volatility ?? defaultVolatility(entry.category),
        });

        // An omitted `base_version_id` means "I did not read the current value". Recording
        // the pointer as observed *now* still lets publication detect a later change.
        const baseVersionId =
          entry.base_version_id === undefined ? item.currentVersionId : entry.base_version_id;

        const body = entry.body.trim();
        const data = entry.data ?? {};
        const evidence = (entry.evidence ?? []) as EvidenceItem[];

        const candidate = await this.deps.memory.insertVersion(tx, {
          memoryItemId: item.id,
          memoryUpdateId: created.id,
          baseVersionId,
          body,
          data,
          evidence,
          contentHash: contentHash(`${entry.memory_key}\n${body}\n${JSON.stringify(data)}`),
          confidence: entry.confidence,
          verificationState: entry.verification_state,
          searchText: buildSearchText(entry.memory_key, body, data),
          createdBySessionId: input.sessionId ?? null,
        });

        await this.deps.memory.addUpdateItem(tx, {
          memoryUpdateId: created.id,
          memoryItemId: item.id,
          baseVersionId,
          candidateVersionId: candidate.id,
        });

        // Embedding is queued inside the same transaction, so a candidate can never exist
        // without its embedding job.
        await this.deps.jobs.enqueueIn(tx, {
          projectId: input.project.id,
          jobType: 'embedding',
          entityType: 'memory_version',
          entityId: candidate.id,
          dedupeKey: candidate.id,
          payload: { memory_version_id: candidate.id },
          correlationId: input.correlationId ?? null,
          priority: 5,
        });
      }

      // Validation, snapshot preparation and (in `auto` mode) publication run in the worker.
      await this.deps.jobs.enqueueIn(tx, {
        projectId: input.project.id,
        jobType: 'memory_validation',
        entityType: 'memory_update',
        entityId: created.id,
        dedupeKey: created.id,
        payload: { memory_update_id: created.id },
        correlationId: input.correlationId ?? null,
        priority: 4,
      });

      return created;
    });

    return update;
  }

  // --- validation ----------------------------------------------------------

  /**
   * Move `draft`/`validating` to `ready`, preparing the snapshot that publication will
   * activate. Returns the update unchanged if it is already past validation.
   */
  async validate(updateId: string): Promise<MemoryUpdate> {
    return withTransaction(this.deps.pool, async (tx) => {
      const update = await this.requireUpdate(tx, updateId, true);
      if (update.state === 'ready') return update;
      if (update.state !== 'draft' && update.state !== 'validating') {
        throw new SagaError(
          'MEMORY_UPDATE_STATE_INVALID',
          `A ${update.state} Lore update cannot be validated.`,
          { details: { state: update.state } },
        );
      }

      const items = await this.deps.memory.listUpdateItems(tx, updateId);
      if (items.length === 0) {
        return this.deps.memory.setUpdateState(tx, updateId, 'failed', {
          error: 'The update contains no entries.',
        });
      }

      // Re-run the secret policy against what was actually stored: the candidate rows, not
      // the request body, so a direct database write cannot bypass the check.
      for (const item of items) {
        const candidate = await this.deps.memory.findVersionById(tx, item.candidateVersionId);
        if (candidate === null) {
          return this.deps.memory.setUpdateState(tx, updateId, 'failed', {
            error: `The candidate version for "${item.memoryKey}" is missing.`,
          });
        }
        const findings = scanForSecrets({
          body: candidate.body,
          data: candidate.data,
          evidence: candidate.evidence,
        });
        if (findings.length > 0) {
          return this.deps.memory.setUpdateState(tx, updateId, 'failed', {
            error: `Rejected by the secret policy: ${describeFindings(findings)}.`,
          });
        }
      }

      const snapshot = await this.prepareSnapshot(tx, update.projectId, items);
      return this.deps.memory.setUpdateState(tx, updateId, 'ready', {
        preparedSnapshotId: snapshot.id,
      });
    });
  }

  /**
   * Build the snapshot the project *would* have if this update published: current versions
   * for every untouched item, candidate versions for the touched ones.
   */
  private async prepareSnapshot(
    tx: Queryable,
    projectId: string,
    updateItems: readonly MemoryUpdateItem[],
  ): Promise<ContextSnapshot> {
    const project = await this.deps.projects.findById(tx, projectId);
    if (project === null) throw new SagaError('PROJECT_NOT_FOUND', 'The project no longer exists.');

    const existing = await this.deps.memory.listItems(tx, { projectId, limit: 5_000 });
    const candidateByItem = new Map<string, string>(
      updateItems.map((item) => [item.memoryItemId, item.candidateVersionId]),
    );

    const projected: MemoryItemWithVersion[] = [];
    for (const item of existing) {
      const candidateId = candidateByItem.get(item.id);
      if (candidateId === undefined) {
        projected.push(item);
        continue;
      }
      const candidate = await this.deps.memory.findVersionById(tx, candidateId);
      // A published entry is active by definition, whatever its previous stale state.
      projected.push({ ...item, state: 'active', staleReason: null, currentVersion: candidate });
    }

    const built = buildSections({
      items: projected,
      specs: CORE_SECTIONS,
      tokenBudget: this.deps.coreContextTokens,
    });

    return this.deps.snapshots.createReady(tx, {
      projectId,
      // The snapshot is built for the revision this update will create.
      projectRevision: project.memoryRevision + 1,
      sections: built.sections,
      renderedContext: built.rendered,
      tokenCount: built.tokenCount,
    });
  }

  // --- publication ---------------------------------------------------------

  /**
   * Publish atomically (ADR-0005):
   *   1. lock every affected item in ascending id order
   *   2. compare each item's current pointer with the update's base pointer
   *   3. any mismatch → change nothing, mark `conflict`, throw 409
   *   4. repoint, bump the revision once, activate the prepared snapshot, emit the event
   *
   * Before commit, readers see the old coherent state; after commit, the new one.
   */
  async publish(updateId: string): Promise<{ update: MemoryUpdate; memoryRevision: number }> {
    type Outcome =
      | { kind: 'published'; update: MemoryUpdate; memoryRevision: number }
      | { kind: 'conflict'; conflicts: PublishConflict[] };

    const outcome = await withTransaction<Outcome>(this.deps.pool, async (tx) => {
      const update = await this.requireUpdate(tx, updateId, true);
      if (update.state === 'published') {
        const project = await this.deps.projects.findById(tx, update.projectId);
        return { kind: 'published', update, memoryRevision: project?.memoryRevision ?? 0 };
      }
      if (!canTransition(update.state, 'published')) {
        throw new SagaError(
          'MEMORY_UPDATE_STATE_INVALID',
          `A ${update.state} Lore update cannot be published. Validate it first.`,
          { details: { state: update.state } },
        );
      }

      const items = await this.deps.memory.listUpdateItems(tx, updateId);
      const locked = await this.deps.memory.lockItems(
        tx,
        items.map((item) => item.memoryItemId),
      );
      const lockedById = new Map(locked.map((item) => [item.id, item]));

      const conflicts: PublishConflict[] = [];
      for (const item of items) {
        const current = lockedById.get(item.memoryItemId);
        if (current === undefined) {
          conflicts.push({ memory_key: item.memoryKey, expected: item.baseVersionId, actual: null });
          continue;
        }
        if (current.currentVersionId !== item.baseVersionId) {
          conflicts.push({
            memory_key: item.memoryKey,
            expected: item.baseVersionId,
            actual: current.currentVersionId,
          });
        }
      }

      if (conflicts.length > 0) {
        // Return rather than throw: marking the update `conflict` inside this transaction
        // would be rolled back with it, leaving the update stuck in `ready` forever. The
        // caller records the conflict in its own transaction below.
        return { kind: 'conflict', conflicts };
      }

      const now = new Date();
      for (const item of items) {
        await this.deps.memory.setCurrentVersion(tx, item.memoryItemId, item.candidateVersionId, now);
      }

      const memoryRevision = await this.deps.projects.bumpMemoryRevision(tx, update.projectId);

      let snapshotId = update.preparedSnapshotId;
      if (snapshotId === null) {
        // Defensive: a `ready` update always has one, but never publish without a snapshot.
        const rebuilt = await this.prepareSnapshot(tx, update.projectId, items);
        snapshotId = rebuilt.id;
      }
      await this.deps.snapshots.activate(tx, update.projectId, snapshotId);
      await this.deps.projects.setActiveContextSnapshot(tx, update.projectId, snapshotId);

      const published = await this.deps.memory.setUpdateState(tx, updateId, 'published', {
        preparedSnapshotId: snapshotId,
      });

      await this.deps.outbox.emit(tx, {
        aggregateType: 'memory_update',
        aggregateId: updateId,
        topic: 'lore.memory_published',
        payload: {
          memory_update_id: updateId,
          memory_revision: memoryRevision,
          entry_count: items.length,
          memory_keys: items.map((item) => item.memoryKey),
          snapshot_id: snapshotId,
        },
        correlationId: update.correlationId,
        projectId: update.projectId,
      });

      return { kind: 'published', update: published, memoryRevision };
    });

    if (outcome.kind === 'conflict') {
      const summary = outcome.conflicts.map((conflict) => conflict.memory_key).join(', ');
      await withTransaction(this.deps.pool, (tx) =>
        this.deps.memory.setUpdateState(tx, updateId, 'conflict', {
          error: `Conflicting entries: ${summary}.`,
        }),
      );
      throw new SagaError(
        'MEMORY_UPDATE_CONFLICT',
        'One or more Lore Entries changed since this update was prepared. Re-read them and propose again.',
        { details: { conflicts: outcome.conflicts } },
      );
    }

    return { update: outcome.update, memoryRevision: outcome.memoryRevision };
  }

  async cancel(updateId: string, reason: string): Promise<MemoryUpdate> {
    return withTransaction(this.deps.pool, async (tx) => {
      const update = await this.requireUpdate(tx, updateId, true);
      if (update.state === 'cancelled') return update;
      if (!canTransition(update.state, 'cancelled')) {
        throw new SagaError(
          'MEMORY_UPDATE_STATE_INVALID',
          `A ${update.state} Lore update cannot be cancelled.`,
          { details: { state: update.state } },
        );
      }
      return this.deps.memory.setUpdateState(tx, updateId, 'cancelled', { error: reason });
    });
  }

  async markFailed(updateId: string, error: string): Promise<MemoryUpdate> {
    return withTransaction(this.deps.pool, (tx) =>
      this.deps.memory.setUpdateState(tx, updateId, 'failed', { error }),
    );
  }

  async beginValidating(updateId: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const update = await this.requireUpdate(tx, updateId, true);
      if (update.state === 'draft') {
        await this.deps.memory.setUpdateState(tx, updateId, 'validating');
      }
    });
  }

  // --- reads ---------------------------------------------------------------

  async getUpdate(updateId: string): Promise<UpdateWithItems> {
    const update = await this.deps.memory.findUpdateById(this.deps.pool, updateId);
    if (update === null) {
      throw new SagaError('MEMORY_UPDATE_NOT_FOUND', 'No Lore update matches that id.', {
        details: { memory_update_id: updateId },
      });
    }
    const items = await this.deps.memory.listUpdateItems(this.deps.pool, updateId);

    const enriched: UpdateWithItems['items'] = [];
    for (const item of items) {
      const candidate = await this.deps.memory.findVersionById(this.deps.pool, item.candidateVersionId);
      if (candidate === null) {
        throw new SagaError(
          'MEMORY_VERSION_NOT_FOUND',
          `The candidate version for "${item.memoryKey}" is missing.`,
        );
      }
      const current = await this.deps.memory.findItemById(this.deps.pool, item.memoryItemId);
      enriched.push({
        ...item,
        candidate,
        // A conflict is visible before publication so Guild Hall can warn the approver.
        conflicted: current?.currentVersionId !== item.baseVersionId,
      });
    }
    return { update, items: enriched };
  }

  async listUpdates(projectId: string, state?: MemoryUpdateState, limit = 50): Promise<MemoryUpdate[]> {
    return this.deps.memory.listUpdates(this.deps.pool, { projectId, state, limit });
  }

  async listEntries(filter: {
    projectId: string;
    category?: MemoryCategory;
    kind?: MemoryKind;
    state?: MemoryState;
    verificationState?: VerificationState;
    volatility?: Volatility;
    minImportance?: number;
    cursor?: string;
    limit: number;
  }): Promise<Page<MemoryItemWithVersion>> {
    const cursor = filter.cursor === undefined ? null : decodeCursor(filter.cursor);
    const rows = await this.deps.memory.listItems(this.deps.pool, {
      ...filter,
      includeArchived: filter.state === 'archived',
      cursorKey: cursor?.k,
      cursorId: cursor?.id,
      limit: filter.limit + 1,
    });
    return buildPage(rows, filter.limit, (item) => ({ k: item.memoryKey, id: item.id }));
  }

  async getEntry(projectId: string, memoryKey: string): Promise<MemoryItemWithVersion> {
    const item = await this.deps.memory.findItemWithVersion(this.deps.pool, projectId, memoryKey);
    if (item === null) {
      throw new SagaError('MEMORY_ITEM_NOT_FOUND', `No Lore Entry named "${memoryKey}".`, {
        details: { memory_key: memoryKey },
      });
    }
    return item;
  }

  async listVersions(projectId: string, memoryKey: string, limit = 50): Promise<MemoryVersion[]> {
    const item = await this.getEntry(projectId, memoryKey);
    return this.deps.memory.listVersionsForItem(this.deps.pool, item.id, limit);
  }

  async activeSnapshot(projectId: string): Promise<ContextSnapshot | null> {
    return this.deps.snapshots.findActive(this.deps.pool, projectId);
  }

  // --- lifecycle -----------------------------------------------------------

  /** Marking stale never deletes: the entry keeps its content and gains a reason. */
  async markStale(project: Project, memoryKey: string, reason: string): Promise<MemoryItem> {
    return withTransaction(this.deps.pool, async (tx) => {
      const item = await this.deps.memory.findItemByKey(tx, project.id, memoryKey);
      if (item === null) {
        throw new SagaError('MEMORY_ITEM_NOT_FOUND', `No Lore Entry named "${memoryKey}".`);
      }
      const updated = await this.deps.memory.markStale(tx, item.id, reason);
      if (updated === null) return item;

      await this.deps.outbox.emit(tx, {
        aggregateType: 'memory_item',
        aggregateId: item.id,
        topic: 'lore.memory_marked_stale',
        payload: { memory_key: memoryKey, reason },
        projectId: project.id,
      });
      return updated;
    });
  }

  async archiveEntry(project: Project, memoryKey: string, reason: string): Promise<MemoryItem> {
    return withTransaction(this.deps.pool, async (tx) => {
      const item = await this.deps.memory.findItemByKey(tx, project.id, memoryKey);
      if (item === null) {
        throw new SagaError('MEMORY_ITEM_NOT_FOUND', `No Lore Entry named "${memoryKey}".`);
      }
      const archived = await this.deps.memory.archiveItem(tx, item.id);
      if (archived === null) return item;

      await this.deps.outbox.emit(tx, {
        aggregateType: 'memory_item',
        aggregateId: item.id,
        topic: 'lore.memory_archived',
        payload: { memory_key: memoryKey, reason },
        projectId: project.id,
      });
      return archived;
    });
  }

  private async requireUpdate(
    tx: Queryable,
    updateId: string,
    lock: boolean,
  ): Promise<MemoryUpdate> {
    const update = lock
      ? await this.deps.memory.lockUpdateById(tx, updateId)
      : await this.deps.memory.findUpdateById(tx, updateId);
    if (update === null) {
      throw new SagaError('MEMORY_UPDATE_NOT_FOUND', 'No Lore update matches that id.', {
        details: { memory_update_id: updateId },
      });
    }
    return update;
  }
}

// --- helpers ---------------------------------------------------------------

function assertBodySize(entry: LoreEntryInput): void {
  if (entry.body.length > MAX_BODY_CHARS) {
    throw new SagaError(
      'MEMORY_BODY_TOO_LARGE',
      `The body of "${entry.memory_key}" is ${entry.body.length} characters; the limit is ${MAX_BODY_CHARS}. Split it into several Lore Entries — chunking is not the abstraction here.`,
      { details: { memory_key: entry.memory_key, length: entry.body.length, max: MAX_BODY_CHARS } },
    );
  }
}

function assertNoSecrets(entry: LoreEntryInput): void {
  const findings = scanForSecrets({
    body: entry.body,
    data: entry.data,
    evidence: entry.evidence,
  });
  if (findings.length > 0) {
    throw new SagaError(
      'MEMORY_SECRET_DETECTED',
      `"${entry.memory_key}" was rejected because ${describeFindings(findings)}. Replace the value with a placeholder or an environment-variable reference; Saga never stores credentials.`,
      {
        details: {
          memory_key: entry.memory_key,
          // The field path is reported; the value never is.
          findings: findings.map((finding) => ({
            field_path: finding.fieldPath,
            rule: finding.ruleId,
          })),
        },
      },
    );
  }
}

/** Everything an entry should be findable by, flattened for the full-text index. */
export function buildSearchText(
  memoryKey: string,
  body: string,
  data: Record<string, unknown>,
): string {
  const parts = [memoryKey, memoryKey.replaceAll('.', ' ').replaceAll('-', ' '), body];
  collectStrings(data, parts, 0);
  return parts.join('\n').slice(0, 100_000);
}

function collectStrings(value: unknown, out: string[], depth: number): void {
  if (depth > 6) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out.push(key.replaceAll('_', ' '));
    collectStrings(item, out, depth + 1);
  }
}

const HIGH_IMPORTANCE: readonly MemoryCategory[] = ['overview', 'warning', 'structure'];
const OPERATIONAL: readonly MemoryCategory[] = ['running', 'deploy', 'logs', 'debug', 'config'];

export function defaultImportance(category: MemoryCategory): number {
  if (HIGH_IMPORTANCE.includes(category)) return 85;
  if (category === 'decision' || category === 'coding_style') return 70;
  return 50;
}

export function defaultVolatility(category: MemoryCategory): Volatility {
  return OPERATIONAL.includes(category) ? 'operational' : 'stable';
}
