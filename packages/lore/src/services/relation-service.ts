import type { SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import { SagaError } from '@saga/shared';
import type { MemoryItemWithVersion } from '../domain/lore.js';
import { extractRelations } from '../relations/extract.js';
import type { RelationProposer, RelationSubject } from '../relations/provider.js';
import type { InferredLinkInput, LinkRepository } from '../repositories/link-repository.js';
import type { MemoryRepository } from '../repositories/memory-repository.js';
import type { SearchRepository } from '../repositories/search-repository.js';

/**
 * How many entries of a project are loaded to match bare key mentions against.
 *
 * Every key has to be in memory at once for the extractor to recognise it, so this is a real
 * ceiling rather than a page size: a project past it silently stops matching its rarest keys.
 * It is set far above any Lore set seen so far, and the handler logs when it is hit.
 */
export const MAX_KEYS_SCANNED = 5_000;

export interface RelationServiceDeps {
  pool: SagaPool;
  memory: MemoryRepository;
  links: LinkRepository;
  search: SearchRepository;
  proposer: RelationProposer;
  /** Nearest neighbours offered to the model per entry. */
  maxCandidates: number;
  /** Proposals below this are dropped rather than queued for review. */
  minConfidence: number;
}

export interface InferenceOptions {
  /**
   * Called after each entry is processed. The handler passes the job's lease renewal here: one
   * model call may take the whole provider timeout, so a busy update can outlive the default
   * 60-second lease many times over and be reclaimed mid-flight by a second worker.
   */
  onProgress?: () => Promise<unknown>;
}

export interface InferenceOutcome {
  /** Entries whose bodies were examined. */
  scanned: number;
  /** Relations written confirmed, from `[[key]]` links and bare mentions. */
  confirmed: number;
  /** Relations written proposed, from the model. */
  proposed: number;
  /** Relations the model offered that were below `minConfidence`. */
  belowConfidence: number;
  /** True when the project has more entries than `MAX_KEYS_SCANNED`. */
  truncated: boolean;
  /** Set when the model could not be reached; the deterministic half still ran. */
  proposerError: string | null;
}

/**
 * Derives relations from entries the server already holds.
 *
 * The two halves are deliberately unequal. Text matching reads relations out of what a person
 * wrote, so it writes them straight into the graph. The model is guessing which of nine
 * relation words applies to two entries that merely embed near each other, so it writes
 * proposals nobody has to accept. A model outage degrades to the first half alone rather than
 * failing the job — the deterministic relations are just as correct without it.
 */
export class RelationService {
  constructor(private readonly deps: RelationServiceDeps) {}

  async inferForUpdate(
    updateId: string,
    options: InferenceOptions = {},
  ): Promise<InferenceOutcome> {
    const update = await this.deps.memory.findUpdateById(this.deps.pool, updateId);
    if (update === null) {
      throw new SagaError('MEMORY_UPDATE_NOT_FOUND', 'No such Lore update.');
    }
    const items = await this.deps.memory.listUpdateItems(this.deps.pool, updateId);
    return this.inferForItems(
      update.projectId,
      items.map((item) => item.memoryItemId),
      options,
    );
  }

  async inferForItems(
    projectId: string,
    memoryItemIds: readonly string[],
    options: InferenceOptions = {},
  ): Promise<InferenceOutcome> {
    const outcome: InferenceOutcome = {
      scanned: 0,
      confirmed: 0,
      proposed: 0,
      belowConfidence: 0,
      truncated: false,
      proposerError: null,
    };
    if (memoryItemIds.length === 0) return outcome;

    // One read of the project's entries serves both halves: the key set the extractor matches
    // against, and the bodies the model is shown.
    const entries = await this.deps.memory.listItems(this.deps.pool, {
      projectId,
      limit: MAX_KEYS_SCANNED + 1,
    });
    outcome.truncated = entries.length > MAX_KEYS_SCANNED;
    const scanned = outcome.truncated ? entries.slice(0, MAX_KEYS_SCANNED) : entries;

    const byId = new Map(scanned.map((entry) => [entry.id, entry]));
    const byKey = new Map(scanned.map((entry) => [entry.memoryKey, entry]));
    const allKeys = scanned.map((entry) => entry.memoryKey);

    const deterministic: InferredLinkInput[] = [];
    const modelled: InferredLinkInput[] = [];

    for (const itemId of memoryItemIds) {
      const subject = byId.get(itemId);
      const body = subject?.currentVersion?.body;
      // An entry published in this update but archived since, or one whose version vanished.
      if (subject === undefined || body === undefined) continue;
      outcome.scanned += 1;

      deterministic.push(...this.deterministicFor(subject, body, allKeys, byKey));

      const proposals = await this.modelFor(projectId, subject, body, byId, outcome);
      modelled.push(...proposals);

      // After the model call, not before: that is the step that takes real time.
      await options.onProgress?.();
    }

    const written = await withTransaction(this.deps.pool, async (tx) => {
      const confirmed = await this.deps.links.insertInferred(tx, deterministic);
      const proposed = await this.deps.links.insertInferred(tx, modelled);
      return { confirmed: confirmed.length, proposed: proposed.length };
    });

    outcome.confirmed = written.confirmed;
    outcome.proposed = written.proposed;
    return outcome;
  }

  private deterministicFor(
    subject: MemoryItemWithVersion,
    body: string,
    allKeys: readonly string[],
    byKey: ReadonlyMap<string, MemoryItemWithVersion>,
  ): InferredLinkInput[] {
    // The subject's own key is removed rather than filtered afterwards: an entry that names
    // itself would otherwise produce a self-link the schema rejects.
    const others = allKeys.filter((key) => key !== subject.memoryKey);

    const inputs: InferredLinkInput[] = [];
    for (const found of extractRelations(body, others)) {
      const target = byKey.get(found.toMemoryKey);
      if (target === undefined) continue;
      inputs.push({
        projectId: subject.projectId,
        fromMemoryItemId: subject.id,
        relation: found.relation,
        toMemoryItemId: target.id,
        source: 'deterministic',
        metadata: { matched_by: found.form },
      });
    }
    return inputs;
  }

  private async modelFor(
    projectId: string,
    subject: MemoryItemWithVersion,
    body: string,
    byId: ReadonlyMap<string, MemoryItemWithVersion>,
    outcome: InferenceOutcome,
  ): Promise<InferredLinkInput[]> {
    if (this.deps.maxCandidates <= 0) return [];

    const neighbourIds = await this.deps.search.neighboursOf(
      this.deps.pool,
      projectId,
      subject.id,
      this.deps.maxCandidates,
    );

    const candidates: RelationSubject[] = [];
    const idByKey = new Map<string, string>();
    for (const id of neighbourIds) {
      const entry = byId.get(id);
      const candidateBody = entry?.currentVersion?.body;
      if (entry === undefined || candidateBody === undefined) continue;
      candidates.push({ memoryKey: entry.memoryKey, body: candidateBody });
      idByKey.set(entry.memoryKey, entry.id);
    }
    if (candidates.length === 0) return [];

    let proposals;
    try {
      proposals = await this.deps.proposer.propose(
        { memoryKey: subject.memoryKey, body },
        candidates,
      );
    } catch (error) {
      // Recorded, not thrown: the deterministic relations found in the same pass are correct
      // whether or not a model server answered, and losing them to a retry helps nobody.
      outcome.proposerError = error instanceof Error ? error.message : 'unknown';
      return [];
    }

    const inputs: InferredLinkInput[] = [];
    for (const proposal of proposals) {
      if (proposal.confidence < this.deps.minConfidence) {
        outcome.belowConfidence += 1;
        continue;
      }
      const toId = idByKey.get(proposal.toMemoryKey);
      if (toId === undefined) continue;
      inputs.push({
        projectId,
        fromMemoryItemId: subject.id,
        relation: proposal.relation,
        toMemoryItemId: toId,
        source: 'model',
        confidence: proposal.confidence,
        rationale: proposal.rationale,
        metadata: { model: this.deps.proposer.name },
      });
    }
    return inputs;
  }
}
