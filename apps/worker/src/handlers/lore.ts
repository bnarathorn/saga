import type { ProjectRepository } from '@saga/core';
import type { QuestRepository } from '@saga/quest';
import type { SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import type {
  EmbeddingProvider,
  LoreService,
  MemoryRepository,
  SnapshotRepository,
} from '@saga/lore';
import { CORE_SECTIONS, buildSearchText, buildSections } from '@saga/lore';
import { errorMessage, isSagaError } from '@saga/shared';
import { JobHandlerError, type JobHandler } from '@saga/shrine';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// embedding
// ---------------------------------------------------------------------------

/**
 * One handler serves both embeddable entities. Quests are embedded so that activation can
 * use semantic similarity when matching a task to existing work; Lore versions are embedded
 * for hybrid search.
 */
const embeddingPayload = z.union([
  z.object({ memory_version_id: z.string().uuid() }),
  z.object({ work_item_id: z.string().uuid() }),
]);

export interface EmbeddingHandlerDeps {
  pool: SagaPool;
  memory: MemoryRepository;
  quests: QuestRepository;
  provider: EmbeddingProvider;
}

/**
 * Computes the vector for one immutable candidate version. Embedding fields are the only
 * part of a version that may change after insertion.
 */
export function createEmbeddingHandler(deps: EmbeddingHandlerDeps): JobHandler {
  return {
    type: 'embedding',
    describe: {
      input: '{ memory_version_id: uuid } | { work_item_id: uuid }',
      idempotency:
        'Re-running overwrites the same version row with an identical vector; the deterministic provider makes that a no-op in practice.',
      retryPolicy:
        'Provider timeouts and outages retry with backoff. A dimension mismatch or a deleted version fails permanently.',
      sideEffects: 'Sets embedding, embedding_state=ready, embedding_model and ready_at.',
      result: '{ memory_version_id, dimensions, model }',
      failureCodes: [
        'EMBEDDING_PROVIDER_UNAVAILABLE',
        'EMBEDDING_DIMENSION_MISMATCH',
        'MEMORY_VERSION_NOT_FOUND',
      ],
    },

    async handle({ job, logger }) {
      const parsed = embeddingPayload.safeParse(job.payload);
      if (!parsed.success) {
        throw JobHandlerError.permanent('The embedding payload does not match its schema.');
      }

      if ('work_item_id' in parsed.data) {
        return embedQuest(deps, parsed.data.work_item_id, logger);
      }
      const versionId = parsed.data.memory_version_id;

      const version = await deps.memory.findVersionById(deps.pool, versionId);
      if (version === null) {
        // The candidate was cancelled or its update was deleted; nothing to embed.
        throw JobHandlerError.permanent(
          'MEMORY_VERSION_NOT_FOUND: the memory version no longer exists.',
        );
      }
      if (version.embeddingState === 'ready') {
        return {
          memory_version_id: versionId,
          dimensions: deps.provider.dimensions,
          skipped: true,
        };
      }

      await deps.memory.setEmbeddingState(deps.pool, versionId, 'claimed');

      const text = buildSearchText(`${version.memoryItemId}`, version.body, version.data);
      let vector: number[] | undefined;
      try {
        [vector] = await deps.provider.embed([text]);
      } catch (error) {
        await deps.memory.setEmbeddingState(deps.pool, versionId, 'failed');
        if (isSagaError(error) && error.code === 'EMBEDDING_DIMENSION_MISMATCH') {
          throw JobHandlerError.permanent(error.message, error.details);
        }
        throw JobHandlerError.retryable(errorMessage(error));
      }

      if (vector === undefined) {
        await deps.memory.setEmbeddingState(deps.pool, versionId, 'failed');
        throw JobHandlerError.retryable('The embedding provider returned no vector.');
      }

      const updated = await deps.memory.setEmbedding(
        deps.pool,
        versionId,
        vector,
        deps.provider.name,
      );
      if (!updated) {
        throw JobHandlerError.permanent(
          'The memory version disappeared while it was being embedded.',
        );
      }

      logger.debug({ memory_version_id: versionId }, 'embedding stored');
      return {
        memory_version_id: versionId,
        dimensions: deps.provider.dimensions,
        model: deps.provider.name,
      };
    },
  };
}

/** Embed a Quest title, objective and declared scope so activation can match semantically. */
async function embedQuest(
  deps: EmbeddingHandlerDeps,
  workItemId: string,
  logger: { debug: (payload: object, message: string) => void },
): Promise<Record<string, unknown>> {
  const quest = await deps.quests.findById(deps.pool, workItemId);
  if (quest === null) {
    throw JobHandlerError.permanent('QUEST_NOT_FOUND: the Quest no longer exists.');
  }
  if (quest.embeddingState === 'ready') {
    return { work_item_id: workItemId, skipped: true };
  }

  const text = [
    quest.title,
    quest.objective ?? '',
    ...Object.values(quest.scope).flat().map(String),
  ]
    .filter((part) => part.length > 0)
    .join('\n');

  let vector: number[] | undefined;
  try {
    [vector] = await deps.provider.embed([text]);
  } catch (error) {
    await deps.quests.setEmbeddingState(deps.pool, workItemId, 'failed');
    if (isSagaError(error) && error.code === 'EMBEDDING_DIMENSION_MISMATCH') {
      throw JobHandlerError.permanent(error.message, error.details);
    }
    throw JobHandlerError.retryable(errorMessage(error));
  }
  if (vector === undefined) {
    await deps.quests.setEmbeddingState(deps.pool, workItemId, 'failed');
    throw JobHandlerError.retryable('The embedding provider returned no vector.');
  }

  await deps.quests.setEmbedding(deps.pool, workItemId, vector);
  logger.debug({ work_item_id: workItemId }, 'quest embedding stored');
  return { work_item_id: workItemId, dimensions: deps.provider.dimensions };
}

// ---------------------------------------------------------------------------
// memory_validation
// ---------------------------------------------------------------------------

const validationPayload = z.object({ memory_update_id: z.string().uuid() });

export interface MemoryValidationDeps {
  pool: SagaPool;
  lore: LoreService;
  memory: MemoryRepository;
  projects: ProjectRepository;
}

/** Embeddings are waited for, but not forever: after this the update publishes text-only. */
const EMBEDDING_WAIT_ATTEMPTS = 3;

/**
 * Drives an update from `draft` to `ready`, then publishes it when the project's approval
 * mode is `auto`. In `manual` mode it stops at `ready` and waits for Guild Hall.
 */
export function createMemoryValidationHandler(deps: MemoryValidationDeps): JobHandler {
  return {
    type: 'memory_validation',
    describe: {
      input: '{ memory_update_id: uuid }',
      idempotency:
        'Re-running an already published or cancelled update is a no-op; validation itself is derived from stored candidates.',
      retryPolicy:
        'Retries while embeddings are still queued, up to a bounded number of attempts, then proceeds text-only. Secret-policy rejection is permanent.',
      sideEffects:
        'Moves the update through validating → ready, prepares a context snapshot, and in auto mode publishes and activates it.',
      result: '{ memory_update_id, state, memory_revision? }',
      failureCodes: [
        'MEMORY_SECRET_DETECTED',
        'MEMORY_UPDATE_CONFLICT',
        'MEMORY_UPDATE_STATE_INVALID',
      ],
    },

    async handle({ job, logger }) {
      const parsed = validationPayload.safeParse(job.payload);
      if (!parsed.success) {
        throw JobHandlerError.permanent('The validation payload does not match its schema.');
      }
      const updateId = parsed.data.memory_update_id;

      const update = await deps.lore.getUpdate(updateId).catch(() => null);
      if (update === null) {
        throw JobHandlerError.permanent('The Lore update no longer exists.');
      }
      if (update.update.state === 'published' || update.update.state === 'cancelled') {
        return { memory_update_id: updateId, state: update.update.state, skipped: true };
      }

      await deps.lore.beginValidating(updateId);

      // Wait for embeddings so the published snapshot is immediately searchable by vector.
      // After a bounded number of attempts, publish anyway rather than blocking knowledge on
      // an unavailable provider — text search still works.
      const candidateIds = update.items.map((item) => item.candidateVersionId);
      const states = await deps.memory.embeddingStatesFor(deps.pool, candidateIds);
      const pending = [...states.values()].filter(
        (state) => state === 'queued' || state === 'claimed',
      ).length;

      if (pending > 0 && job.attempts < EMBEDDING_WAIT_ATTEMPTS) {
        throw JobHandlerError.retryable(
          `Waiting for ${pending} embedding job(s) before the update is marked ready.`,
        );
      }
      if (pending > 0) {
        logger.warn(
          { memory_update_id: updateId, pending },
          'publishing with embeddings still pending; vector search will lag until they complete',
        );
      }

      const validated = await deps.lore.validate(updateId);
      if (validated.state === 'failed') {
        // A secret-policy rejection is a real outcome, not an infrastructure failure: the
        // update is recorded as failed and the job succeeds having recorded it.
        return { memory_update_id: updateId, state: 'failed', error: validated.error };
      }

      const project = await deps.projects.findById(deps.pool, validated.projectId);
      if (project === null) {
        throw JobHandlerError.permanent('The project no longer exists.');
      }
      if (project.loreApprovalMode === 'manual') {
        return { memory_update_id: updateId, state: 'ready', awaiting_approval: true };
      }

      try {
        const published = await deps.lore.publish(updateId);
        return {
          memory_update_id: updateId,
          state: published.update.state,
          memory_revision: published.memoryRevision,
        };
      } catch (error) {
        if (isSagaError(error) && error.code === 'MEMORY_UPDATE_CONFLICT') {
          // The update is already recorded as `conflict`; the proposer must re-read and retry.
          return { memory_update_id: updateId, state: 'conflict', conflicts: error.details };
        }
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// context_snapshot
// ---------------------------------------------------------------------------

const snapshotPayload = z.object({ project_id: z.string().uuid() });

export interface ContextSnapshotDeps {
  pool: SagaPool;
  lore: LoreService;
  projects: ProjectRepository;
  memory: MemoryRepository;
  snapshots: SnapshotRepository;
  coreContextTokens: number;
}

/**
 * Rebuild and activate a project's core snapshot outside a publish. Used after an entry is
 * marked stale or archived, where no new Lore version is created but the compiled context
 * must change.
 */
export function createContextSnapshotHandler(deps: ContextSnapshotDeps): JobHandler {
  return {
    type: 'context_snapshot',
    describe: {
      input: '{ project_id: uuid }',
      idempotency:
        'Deterministic for the same current versions and configuration; re-running produces an identical snapshot and re-activates it.',
      retryPolicy: 'Standard backoff. A missing project fails permanently.',
      sideEffects: 'Inserts a context snapshot and moves core.projects.active_context_snapshot_id.',
      result: '{ project_id, snapshot_id, token_count }',
      failureCodes: ['PROJECT_NOT_FOUND'],
    },

    async handle({ job }) {
      const parsed = snapshotPayload.safeParse(job.payload);
      if (!parsed.success) {
        throw JobHandlerError.permanent('The snapshot payload does not match its schema.');
      }
      const projectId = parsed.data.project_id;

      return withTransaction(deps.pool, async (tx) => {
        const project = await deps.projects.lockById(tx, projectId);
        if (project === null) {
          throw JobHandlerError.permanent('PROJECT_NOT_FOUND: the project no longer exists.');
        }

        const items = await deps.memory.listItems(tx, { projectId, limit: 5_000 });
        const built = buildSections({
          items,
          specs: CORE_SECTIONS,
          tokenBudget: deps.coreContextTokens,
        });

        const snapshot = await deps.snapshots.createReady(tx, {
          projectId,
          projectRevision: project.memoryRevision,
          sections: built.sections,
          renderedContext: built.rendered,
          tokenCount: built.tokenCount,
        });
        await deps.snapshots.activate(tx, projectId, snapshot.id);
        await deps.projects.setActiveContextSnapshot(tx, projectId, snapshot.id);

        return { project_id: projectId, snapshot_id: snapshot.id, token_count: built.tokenCount };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// stale_detection
// ---------------------------------------------------------------------------

const staleDetectionPayload = z.object({
  project_id: z.string().uuid(),
  /** Reported by the CLI or agent; the server never reads the user's source tree. */
  observations: z
    .array(z.object({ path: z.string(), content_hash: z.string().nullable() }))
    .default([]),
});

export interface StaleDetectionDeps {
  pool: SagaPool;
  lore: LoreService;
  memory: MemoryRepository;
  projects: ProjectRepository;
}

/**
 * Compares recorded evidence against reported observations and marks drifted entries stale.
 * Also applies the operational freshness policy.
 */
export function createStaleDetectionHandler(deps: StaleDetectionDeps): JobHandler {
  return {
    type: 'stale_detection',
    describe: {
      input: '{ project_id: uuid, observations: [{ path, content_hash | null }] }',
      idempotency: 'Marking an already stale entry stale again is a no-op.',
      retryPolicy: 'Standard backoff.',
      sideEffects:
        'Sets memory_items.state=stale with a reason and emits lore.memory_marked_stale.',
      result: '{ project_id, checked, marked_stale: [memory_key] }',
      failureCodes: ['PROJECT_NOT_FOUND'],
    },

    async handle({ job }) {
      const parsed = staleDetectionPayload.safeParse(job.payload);
      if (!parsed.success) {
        throw JobHandlerError.permanent('The stale-detection payload does not match its schema.');
      }
      const { project_id: projectId, observations } = parsed.data;

      const project = await deps.projects.findById(deps.pool, projectId);
      if (project === null) {
        throw JobHandlerError.permanent('PROJECT_NOT_FOUND: the project no longer exists.');
      }

      const observed = new Map(observations.map((entry) => [entry.path, entry.content_hash]));
      const items = await deps.memory.listItems(deps.pool, {
        projectId,
        state: 'active',
        limit: 5_000,
      });
      const markedStale: string[] = [];

      for (const item of items) {
        if (item.currentVersion === null) continue;
        for (const evidence of item.currentVersion.evidence) {
          if (!observed.has(evidence.path)) continue;
          const observedHash = observed.get(evidence.path) ?? null;

          if (observedHash === null) {
            await deps.lore.markStale(
              project,
              item.memoryKey,
              `The evidence file "${evidence.path}" no longer exists.`,
            );
            markedStale.push(item.memoryKey);
            break;
          }
          if (evidence.content_hash !== undefined && evidence.content_hash !== observedHash) {
            await deps.lore.markStale(
              project,
              item.memoryKey,
              `The evidence file "${evidence.path}" changed since this entry was recorded.`,
            );
            markedStale.push(item.memoryKey);
            break;
          }
        }
      }

      return { project_id: projectId, checked: items.length, marked_stale: markedStale };
    },
  };
}

/** Shared by the handler above and the evidence-check API route. */
export function evidenceDrift(
  evidence: readonly { path: string; content_hash?: string }[],
  observed: ReadonlyMap<string, string | null>,
): {
  path: string;
  recordedHash: string | null;
  observedHash: string | null;
  reason: 'hash_changed' | 'path_missing';
} | null {
  for (const entry of evidence) {
    if (!observed.has(entry.path)) continue;
    const observedHash = observed.get(entry.path) ?? null;
    if (observedHash === null) {
      return {
        path: entry.path,
        recordedHash: entry.content_hash ?? null,
        observedHash: null,
        reason: 'path_missing',
      };
    }
    if (entry.content_hash !== undefined && entry.content_hash !== observedHash) {
      return {
        path: entry.path,
        recordedHash: entry.content_hash,
        observedHash,
        reason: 'hash_changed',
      };
    }
  }
  return null;
}
