import type { SagaPool } from '@saga/database';
import { SagaError } from '@saga/shared';
import { createSilentLogger } from '@saga/shared/logging';
import { JobHandlerError, type ClaimedJob, type JobHandler } from '@saga/shrine';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddingHandler,
  createMemoryValidationHandler,
  createRelationInferenceHandler,
} from './lore.js';
import { createPartyReaperHandler, createSessionReaperHandler } from './quest.js';

/**
 * Handler behaviour that each `describe` block promises but nothing checked.
 *
 * Every claim in `describe.idempotency` and `describe.retryPolicy` is a contract the job queue
 * relies on: a handler that marks a transient database failure permanent strands real work
 * after one attempt, and an operator has to notice by hand.
 */

const POOL = {} as SagaPool;

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    projectId: null,
    jobType: 'test',
    entityType: null,
    entityId: null,
    dedupeKey: null,
    state: 'claimed',
    priority: 0,
    payload: {},
    result: null,
    attempts: 1,
    maxAttempts: 3,
    runAfter: new Date(),
    claimedBy: null,
    claimToken: 'test',
    claimedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    lastError: null,
    correlationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  } as ClaimedJob;
}

function run(
  handler: JobHandler,
  overrides: Partial<ClaimedJob> = {},
  signal = new AbortController().signal,
): Promise<unknown> {
  return handler.handle({
    job: job({ ...overrides, jobType: handler.type }),
    logger: createSilentLogger(),
    signal,
    renewLease: () => Promise.resolve(true),
  });
}

/** Assert a rejection is a JobHandlerError classified the way the queue needs it. */
async function expectFailure(
  promise: Promise<unknown>,
  kind: 'permanent' | 'retryable',
): Promise<JobHandlerError> {
  const error = (await promise.then(
    () => null,
    (caught: unknown) => caught,
  )) as JobHandlerError | null;
  expect(error).toBeInstanceOf(JobHandlerError);
  expect(error!.kind).toBe(kind);
  return error!;
}

const VERSION_ID = '00000000-0000-4000-8000-000000000100';
const UPDATE_ID = '00000000-0000-4000-8000-000000000200';
const PROJECT_ID = '00000000-0000-4000-8000-000000000010';

// ---------------------------------------------------------------------------
// embedding
// ---------------------------------------------------------------------------

function embeddingDeps(overrides: Record<string, unknown> = {}) {
  return {
    pool: POOL,
    memory: {
      findVersionById: vi.fn(async () => ({
        id: VERSION_ID,
        memoryItemId: 'item-1',
        body: 'Start PostgreSQL first.',
        data: {},
        embeddingState: 'queued',
      })),
      setEmbeddingState: vi.fn(async () => true),
      setEmbedding: vi.fn(async () => true),
    },
    quests: { setEmbedding: vi.fn(async () => true) },
    provider: {
      name: 'fake',
      dimensions: 8,
      embed: vi.fn(async () => [[0, 1, 2, 3, 4, 5, 6, 7]]),
    },
    ...overrides,
  };
}

describe('embedding handler', () => {
  it('rejects a payload that matches neither shape, permanently', async () => {
    const deps = embeddingDeps();
    await expectFailure(
      run(createEmbeddingHandler(deps as never), { payload: { nonsense: true } }),
      'permanent',
    );
  });

  it('is a no-op for a version that is already embedded', async () => {
    // The idempotency claim: re-running must not re-embed or rewrite the row.
    const deps = embeddingDeps();
    deps.memory.findVersionById = vi.fn(async () => ({
      id: VERSION_ID,
      memoryItemId: 'item-1',
      body: 'x',
      data: {},
      embeddingState: 'ready',
    }));

    const result = (await run(createEmbeddingHandler(deps as never), {
      payload: { memory_version_id: VERSION_ID },
    })) as { skipped: boolean };

    expect(result.skipped).toBe(true);
    expect(deps.provider.embed).not.toHaveBeenCalled();
    expect(deps.memory.setEmbedding).not.toHaveBeenCalled();
  });

  it('fails permanently when the version has been deleted', async () => {
    const deps = embeddingDeps();
    deps.memory.findVersionById = vi.fn(async () => null as never);

    const error = await expectFailure(
      run(createEmbeddingHandler(deps as never), {
        payload: { memory_version_id: VERSION_ID },
      }),
      'permanent',
    );
    expect(error.message).toContain('MEMORY_VERSION_NOT_FOUND');
  });

  it('retries a provider outage and records the failed state', async () => {
    const deps = embeddingDeps();
    deps.provider.embed = vi.fn(async () => {
      throw new SagaError('EMBEDDING_PROVIDER_UNAVAILABLE', 'the provider is down');
    });

    await expectFailure(
      run(createEmbeddingHandler(deps as never), {
        payload: { memory_version_id: VERSION_ID },
      }),
      'retryable',
    );
    expect(deps.memory.setEmbeddingState).toHaveBeenCalledWith(POOL, VERSION_ID, 'failed');
  });

  it('fails permanently on a dimension mismatch, which no retry can fix', async () => {
    const deps = embeddingDeps();
    deps.provider.embed = vi.fn(async () => {
      throw new SagaError('EMBEDDING_DIMENSION_MISMATCH', 'expected 8, got 1536');
    });

    await expectFailure(
      run(createEmbeddingHandler(deps as never), {
        payload: { memory_version_id: VERSION_ID },
      }),
      'permanent',
    );
  });

  it('embeds a Quest when the payload names a work item', async () => {
    const deps = embeddingDeps();
    deps.quests = {
      findById: vi.fn(async () => ({
        id: 'q1',
        title: 'Add CSV export',
        objective: null,
        scope: {},
      })),
      setEmbedding: vi.fn(async () => true),
    } as never;

    await run(createEmbeddingHandler(deps as never), {
      payload: { work_item_id: '00000000-0000-4000-8000-000000000002' },
    });

    expect(
      (deps.quests as { setEmbedding: ReturnType<typeof vi.fn> }).setEmbedding,
    ).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// memory_validation
// ---------------------------------------------------------------------------

function validationDeps(overrides: Record<string, unknown> = {}) {
  return {
    pool: POOL,
    lore: {
      getUpdate: vi.fn(async () => ({
        update: { id: UPDATE_ID, state: 'draft', projectId: PROJECT_ID },
        items: [{ candidateVersionId: VERSION_ID }],
      })),
      beginValidating: vi.fn(async () => undefined),
      validate: vi.fn(async () => ({ state: 'ready', projectId: PROJECT_ID, error: null })),
      publish: vi.fn(async () => ({
        update: { id: UPDATE_ID, state: 'published' },
        memoryRevision: 5,
      })),
    },
    memory: { embeddingStatesFor: vi.fn(async () => new Map([[VERSION_ID, 'ready']])) },
    projects: { findById: vi.fn(async () => ({ id: PROJECT_ID, loreApprovalMode: 'auto' })) },
    ...overrides,
  };
}

describe('memory_validation handler', () => {
  it('lets a transient database failure retry instead of failing on attempt one', async () => {
    // The regression this suite exists for. A blanket catch around `getUpdate` turned a
    // dropped connection into a permanent failure, stranding the update in `draft`.
    const deps = validationDeps();
    deps.lore.getUpdate = vi.fn(async () => {
      throw new Error('Connection terminated unexpectedly');
    });

    const error = await run(createMemoryValidationHandler(deps as never), {
      payload: { memory_update_id: UPDATE_ID },
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    // It propagates as-is: the queue treats an unclassified error as retryable.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Connection terminated');
    expect(error).not.toBeInstanceOf(JobHandlerError);
  });

  it('fails permanently only when the update genuinely does not exist', async () => {
    const deps = validationDeps();
    deps.lore.getUpdate = vi.fn(async () => {
      throw new SagaError('MEMORY_UPDATE_NOT_FOUND', 'gone');
    });

    await expectFailure(
      run(createMemoryValidationHandler(deps as never), {
        payload: { memory_update_id: UPDATE_ID },
      }),
      'permanent',
    );
  });

  it('is a no-op for every terminal state, including failed and conflict', async () => {
    // Not just the happy ones: an admin retry of a failed update would otherwise dead-end,
    // because `validate` refuses anything that is neither draft nor validating.
    for (const state of ['published', 'cancelled', 'failed', 'conflict'] as const) {
      const deps = validationDeps();
      deps.lore.getUpdate = vi.fn(async () => ({
        update: { id: UPDATE_ID, state, projectId: PROJECT_ID },
        items: [],
      }));

      const result = (await run(createMemoryValidationHandler(deps as never), {
        payload: { memory_update_id: UPDATE_ID },
      })) as { state: string; skipped: boolean };

      expect([state, result.skipped]).toEqual([state, true]);
      expect(deps.lore.beginValidating).not.toHaveBeenCalled();
    }
  });

  it('waits for pending embeddings while attempts remain', async () => {
    const deps = validationDeps();
    deps.memory.embeddingStatesFor = vi.fn(async () => new Map([[VERSION_ID, 'queued']]));

    const error = await expectFailure(
      run(createMemoryValidationHandler(deps as never), {
        payload: { memory_update_id: UPDATE_ID },
        attempts: 1,
      }),
      'retryable',
    );
    expect(error.message).toContain('Waiting for 1 embedding');
    expect(deps.lore.validate).not.toHaveBeenCalled();
    // Named as a wait rather than a failure, and carrying a delay of its own. On the standard
    // backoff the three attempts spanned 2-3 seconds against an embedding that takes 13 s on
    // average, so in production every publish burned all three and gave up having waited for
    // nothing — while logging two `job failed` lines on the way.
    expect(error.waiting).toBe(true);
    expect(error.retryAfterMs ?? 0).toBeGreaterThanOrEqual(8_000);
  });

  it('publishes text-only rather than blocking knowledge on an unavailable provider', async () => {
    const deps = validationDeps();
    deps.memory.embeddingStatesFor = vi.fn(async () => new Map([[VERSION_ID, 'queued']]));

    const result = (await run(createMemoryValidationHandler(deps as never), {
      payload: { memory_update_id: UPDATE_ID },
      attempts: 3,
    })) as { state: string };

    expect(result.state).toBe('published');
  });

  it('stops at ready when the project approves Lore manually', async () => {
    const deps = validationDeps();
    deps.projects.findById = vi.fn(async () => ({
      id: PROJECT_ID,
      loreApprovalMode: 'manual',
    }));

    const result = (await run(createMemoryValidationHandler(deps as never), {
      payload: { memory_update_id: UPDATE_ID },
    })) as { state: string; awaiting_approval: boolean };

    expect(result).toMatchObject({ state: 'ready', awaiting_approval: true });
    expect(deps.lore.publish).not.toHaveBeenCalled();
  });

  it('records a secret-policy rejection as an outcome, not an infrastructure failure', async () => {
    const deps = validationDeps();
    deps.lore.validate = vi.fn(async () => ({
      state: 'failed',
      projectId: PROJECT_ID,
      error: 'body contains a password',
    }));

    const result = (await run(createMemoryValidationHandler(deps as never), {
      payload: { memory_update_id: UPDATE_ID },
    })) as { state: string; error: string };

    expect(result).toMatchObject({ state: 'failed', error: 'body contains a password' });
  });

  it('reports a publish conflict as a result the proposer must act on', async () => {
    const deps = validationDeps();
    deps.lore.publish = vi.fn(async () => {
      throw new SagaError('MEMORY_UPDATE_CONFLICT', 'entries changed', {
        details: { memory_keys: ['run.api.local'] },
      });
    });

    const result = (await run(createMemoryValidationHandler(deps as never), {
      payload: { memory_update_id: UPDATE_ID },
    })) as { state: string };

    expect(result.state).toBe('conflict');
  });

  it('rethrows an unexpected publish failure rather than swallowing it', async () => {
    const deps = validationDeps();
    deps.lore.publish = vi.fn(async () => {
      throw new SagaError('SERVICE_UNAVAILABLE', 'the database went away');
    });

    await expect(
      run(createMemoryValidationHandler(deps as never), {
        payload: { memory_update_id: UPDATE_ID },
      }),
    ).rejects.toThrow('the database went away');
  });

  it('rejects a payload that is not a memory update id', async () => {
    await expectFailure(
      run(createMemoryValidationHandler(validationDeps() as never), {
        payload: { memory_update_id: 'not-a-uuid' },
      }),
      'permanent',
    );
  });
});

// ---------------------------------------------------------------------------
// reapers
// ---------------------------------------------------------------------------

describe('reaper handlers', () => {
  it('gives the session reaper work back to the queue during shutdown', async () => {
    const sessions = { reapStaleSessions: vi.fn(async () => ['s1']) };
    const controller = new AbortController();
    controller.abort();

    const error = await expectFailure(
      run(createSessionReaperHandler({ sessions } as never), {}, controller.signal),
      'retryable',
    );
    expect(error.message).toContain('shutting down');
    expect(sessions.reapStaleSessions).not.toHaveBeenCalled();
  });

  it('reports how many sessions it abandoned, capped for the result payload', async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `s${index}`);
    const sessions = { reapStaleSessions: vi.fn(async () => ids) };

    const result = (await run(createSessionReaperHandler({ sessions } as never))) as {
      abandoned: number;
      session_ids: string[];
    };

    expect(result.abandoned).toBe(60);
    expect(result.session_ids).toHaveLength(50);
  });

  it('gives the party reaper work back to the queue during shutdown', async () => {
    const party = { reapExpiredRuns: vi.fn(async () => ({ expired: [], releasedClaims: 0 })) };
    const controller = new AbortController();
    controller.abort();

    await expectFailure(
      run(createPartyReaperHandler({ party } as never), {}, controller.signal),
      'retryable',
    );
    expect(party.reapExpiredRuns).not.toHaveBeenCalled();
  });

  it('reports expired runs and the claims they were holding', async () => {
    const party = {
      reapExpiredRuns: vi.fn(async () => ({ expired: ['r1', 'r2'], releasedClaims: 3 })),
    };

    const result = (await run(createPartyReaperHandler({ party } as never))) as {
      expired: number;
      released_claims: number;
    };

    expect(result).toEqual({ expired: 2, released_claims: 3 });
  });
});

// ---------------------------------------------------------------------------
// relation inference
// ---------------------------------------------------------------------------

describe('relation_inference handler', () => {
  /** Resolves once `release()` is called, so a test can hold inference open. */
  function gate(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  const OUTCOME = {
    scanned: 1,
    confirmed: 0,
    proposed: 0,
    belowConfidence: 0,
    truncated: false,
    proposerError: null,
  };

  it('renews the lease while a single entry is still being inferred', async () => {
    // The failure this guards: one model call may last the entire SAGA_INFERENCE_TIMEOUT_MS,
    // which defaults to exactly the 60-second lease. Renewing only between entries fires for
    // the first time after the claim it protects has already lapsed.
    const held = gate();
    const relations = {
      inferForUpdate: vi.fn(async () => {
        await held.promise;
        return OUTCOME;
      }),
    };
    let renewals = 0;

    const handler = createRelationInferenceHandler({
      relations: relations as never,
      renewalIntervalMs: 10,
    });
    const running = handler.handle({
      job: job({ jobType: 'relation_inference', payload: { memory_update_id: UPDATE_ID } }),
      logger: createSilentLogger(),
      signal: new AbortController().signal,
      renewLease: () => {
        renewals += 1;
        return Promise.resolve(true);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    // Still inside the one and only entry, and the lease has already been renewed.
    expect(renewals).toBeGreaterThan(0);

    held.release();
    await running;

    const afterFinish = renewals;
    await new Promise((resolve) => setTimeout(resolve, 40));
    // And the timer stops with the handler rather than renewing a claim nobody holds.
    expect(renewals).toBe(afterFinish);
  });

  const RENEWAL_FAILURE = 'the connection was reset while renewing the lease';

  it('survives a renewal that rejects instead of taking the worker down with it', async () => {
    // The failure this guards: a discarded renewal promise is an unhandled rejection, and Node
    // exits on those. One database blip during inference would have killed a healthy worker and
    // every other job in flight on it.
    const held = gate();
    const relations = {
      inferForUpdate: vi.fn(async () => {
        await held.promise;
        return OUTCOME;
      }),
    };
    const rejections: unknown[] = [];
    // Only this test's own rejections count: `unhandledRejection` is process-wide, and a
    // listener that collected everything would fail on any unrelated one.
    const onRejection = (reason: unknown): void => {
      if (reason instanceof Error && reason.message === RENEWAL_FAILURE) rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    let renewals = 0;
    const warn = vi.fn();
    const logger = { ...createSilentLogger(), warn } as never;
    const handler = createRelationInferenceHandler({
      relations: relations as never,
      renewalIntervalMs: 10,
    });

    try {
      const running = handler.handle({
        job: job({ jobType: 'relation_inference', payload: { memory_update_id: UPDATE_ID } }),
        logger,
        signal: new AbortController().signal,
        renewLease: () => {
          renewals += 1;
          return Promise.reject(new Error(RENEWAL_FAILURE));
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 60));
      held.release();
      await expect(running).resolves.toMatchObject({ scanned: 1 });

      expect(renewals).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalled();
      // Let any rejection that escaped reach the process before asserting none did.
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('stops renewing when inference fails', async () => {
    const relations = {
      inferForUpdate: vi.fn(async () => {
        throw new SagaError('INTERNAL_ERROR', 'boom');
      }),
    };
    let renewals = 0;

    const handler = createRelationInferenceHandler({
      relations: relations as never,
      renewalIntervalMs: 10,
    });
    await expectFailure(
      handler.handle({
        job: job({ jobType: 'relation_inference', payload: { memory_update_id: UPDATE_ID } }),
        logger: createSilentLogger(),
        signal: new AbortController().signal,
        renewLease: () => {
          renewals += 1;
          return Promise.resolve(true);
        },
      }),
      'retryable',
    );

    const afterFailure = renewals;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(renewals).toBe(afterFailure);
  });

  it('fails permanently for an update that no longer exists', async () => {
    const relations = {
      inferForUpdate: vi.fn(async () => {
        throw new SagaError('MEMORY_UPDATE_NOT_FOUND', 'gone');
      }),
    };
    await expectFailure(
      run(
        createRelationInferenceHandler({ relations: relations as never, renewalIntervalMs: 10 }),
        { payload: { memory_update_id: UPDATE_ID } },
      ),
      'permanent',
    );
  });

  it('rejects a payload that is not an update id', async () => {
    const relations = { inferForUpdate: vi.fn() };
    await expectFailure(
      run(
        createRelationInferenceHandler({ relations: relations as never, renewalIntervalMs: 10 }),
        { payload: { nope: true } },
      ),
      'permanent',
    );
    expect(relations.inferForUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// the described contract itself
// ---------------------------------------------------------------------------

describe('handler self-description (spec 12.9)', () => {
  const handlers: JobHandler[] = [
    createEmbeddingHandler(embeddingDeps() as never),
    createMemoryValidationHandler(validationDeps() as never),
    createRelationInferenceHandler({ relations: {} as never, renewalIntervalMs: 20_000 }),
    createSessionReaperHandler({ sessions: {} } as never),
    createPartyReaperHandler({ party: {} } as never),
  ];

  it('documents input, idempotency, retry policy, side effects and result', () => {
    for (const handler of handlers) {
      for (const field of [
        'input',
        'idempotency',
        'retryPolicy',
        'sideEffects',
        'result',
      ] as const) {
        expect([handler.type, field, handler.describe[field]]).toEqual([
          handler.type,
          field,
          expect.any(String),
        ]);
        // `input` is a type signature and is legitimately as short as `{}`; the rest are prose
        // an operator reads in Shrine, so a stub like "n/a" is not a description.
        const minimum = field === 'input' ? 1 : 20;
        expect([handler.type, field, handler.describe[field].length >= minimum]).toEqual([
          handler.type,
          field,
          true,
        ]);
      }
    }
  });
});
