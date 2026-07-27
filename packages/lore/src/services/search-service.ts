import type {
  LoreSearchHit,
  LoreSearchRequest,
  LoreSearchResponse,
  MemoryRelation,
} from '@saga/contracts';
import type { Project } from '@saga/core';
import type { SagaPool } from '@saga/database';
import { errorMessage } from '@saga/shared';
import type { SagaLogger } from '@saga/shared/logging';
import type { MemoryItemWithVersion } from '../domain/lore.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { type LinkRepository } from '../repositories/link-repository.js';
import { type MemoryRepository } from '../repositories/memory-repository.js';
import { type SearchRepository, type SearchFilters } from '../repositories/search-repository.js';
import {
  applyQuality,
  expandByRelations,
  fuseByReciprocalRank,
  type ChannelResult,
  type RelationEdge,
} from '../search/fusion.js';

export interface SearchServiceDeps {
  pool: SagaPool;
  search: SearchRepository;
  memory: MemoryRepository;
  links: LinkRepository;
  embeddings: EmbeddingProvider;
  logger: SagaLogger;
}

/** How many candidates each channel contributes before fusion. */
const CHANNEL_LIMIT = 40;
const HARD_RESULT_CAP = 100;

export class SearchService {
  constructor(private readonly deps: SearchServiceDeps) {}

  /**
   * Hybrid retrieval: full-text, trigram and vector channels fused by reciprocal rank
   * (ADR-0008), then quality-weighted, then optionally expanded one hop along relations.
   *
   * If the embedding provider is unavailable the vector channel is skipped and the response
   * is marked `degraded` — search keeps working rather than failing.
   */
  async search(project: Project, request: LoreSearchRequest): Promise<LoreSearchResponse> {
    const limit = request.limit ?? 10;
    const filters: SearchFilters = {
      projectId: project.id,
      categories: request.filters?.categories,
      kinds: request.filters?.kinds,
      states: request.filters?.states,
      minImportance: request.filters?.min_importance,
    };

    const warnings: string[] = [];
    const channels: ChannelResult[] = [];

    const [fulltext, trigram] = await Promise.all([
      this.deps.search.fullText(this.deps.pool, filters, request.query, CHANNEL_LIMIT),
      this.deps.search.trigram(this.deps.pool, filters, request.query, CHANNEL_LIMIT),
    ]);
    channels.push({ channel: 'fulltext', ids: fulltext });
    channels.push({ channel: 'trigram', ids: trigram });

    let mode: 'full' | 'degraded' = 'full';
    try {
      const [queryVector] = await this.deps.embeddings.embed([request.query]);
      if (queryVector !== undefined) {
        const vector = await this.deps.search.vector(
          this.deps.pool,
          filters,
          queryVector,
          CHANNEL_LIMIT,
        );
        channels.push({ channel: 'vector', ids: vector });
        if (vector.length === 0 && !(await this.deps.search.hasReadyEmbeddings(this.deps.pool, project.id))) {
          mode = 'degraded';
          warnings.push(
            'No Lore Entry has a ready embedding yet, so results come from text search only. Embeddings are queued.',
          );
        }
      }
    } catch (error) {
      // A provider outage must not fail the search; it downgrades it.
      mode = 'degraded';
      warnings.push(
        'The embedding provider is unavailable, so results come from full-text and trigram search only.',
      );
      this.deps.logger.warn(
        { project_id: project.id, reason: errorMessage(error) },
        'vector search channel unavailable',
      );
    }

    const fused = fuseByReciprocalRank(channels);
    if (fused.length === 0) {
      return { hits: [], mode, warnings, memory_revision: project.memoryRevision };
    }

    // Load enough metadata to weight by quality; only the fused candidates are fetched.
    const candidateIds = fused.slice(0, HARD_RESULT_CAP).map((result) => result.id);
    const items = await this.loadItems(project.id, candidateIds);
    const now = new Date();

    const scored = applyQuality(
      fused.filter((result) => items.has(result.id)),
      (id) => {
        const item = items.get(id);
        if (item === undefined) return undefined;
        return {
          importance: item.importance,
          verificationState: item.currentVersion?.verificationState ?? 'inferred',
          state: item.state,
          volatility: item.volatility,
          lastVerifiedAt: item.lastVerifiedAt,
          now,
        };
      },
    );

    const depth = request.relation_depth ?? 1;
    const edges = depth > 0 ? await this.loadEdges(project.id) : [];
    const expanded = expandByRelations(scored.slice(0, limit), edges, {
      depth,
      maxResults: Math.min(HARD_RESULT_CAP, limit * 3),
    });

    // Relation expansion can surface entries that were not in the fused candidate set.
    const missing = expanded.map((hit) => hit.id).filter((id) => !items.has(id));
    if (missing.length > 0) {
      const extra = await this.loadItems(project.id, missing);
      for (const [id, item] of extra) items.set(id, item);
    }

    const matchedBy = new Map(scored.map((result) => [result.id, result.matchedBy]));
    const keyById = new Map([...items].map(([id, item]) => [id, item.memoryKey]));

    const hits: LoreSearchHit[] = [];
    for (const hit of expanded.slice(0, limit)) {
      const item = items.get(hit.id);
      if (item === undefined || item.currentVersion === null) continue;
      const channelsMatched = matchedBy.get(hit.id) ?? [];
      hits.push({
        memory_key: item.memoryKey,
        memory_item_id: item.id,
        category: item.category,
        kind: item.kind,
        state: item.state,
        importance: item.importance,
        verification_state: item.currentVersion.verificationState,
        volatility: item.volatility,
        body: item.currentVersion.body,
        data: item.currentVersion.data,
        evidence_summary: item.currentVersion.evidence.map((entry) => entry.path),
        last_verified_at: item.lastVerifiedAt?.toISOString() ?? null,
        stale_reason: item.staleReason,
        score: Number(hit.score.toFixed(6)),
        matched_by: hit.viaRelation === null ? channelsMatched : ['relation'],
        via_relation:
          hit.viaRelation === null
            ? null
            : {
                from_memory_key: keyById.get(hit.viaRelation.fromId) ?? hit.viaRelation.fromId,
                relation: hit.viaRelation.relation as MemoryRelation,
              },
      });
    }

    if (hits.some((hit) => hit.state === 'stale')) {
      warnings.push('Some results are marked stale and may no longer reflect the project.');
    }

    return { hits, mode, warnings, memory_revision: project.memoryRevision };
  }

  private async loadItems(
    projectId: string,
    ids: readonly string[],
  ): Promise<Map<string, MemoryItemWithVersion>> {
    const map = new Map<string, MemoryItemWithVersion>();
    if (ids.length === 0) return map;

    const all = await this.deps.memory.listItems(this.deps.pool, {
      projectId,
      limit: 5_000,
      includeArchived: false,
    });
    const wanted = new Set(ids);
    for (const item of all) {
      if (wanted.has(item.id)) map.set(item.id, item);
    }
    return map;
  }

  private async loadEdges(projectId: string): Promise<RelationEdge[]> {
    const links = await this.deps.links.listForProject(this.deps.pool, projectId);
    // Relations are traversed in both directions: knowing that `server.api uses
    // database.primary` is just as useful when the query was about the database. The relation
    // name is kept as declared so the caller sees a value from the documented vocabulary.
    return links.flatMap((link) => [
      { fromId: link.fromMemoryItemId, toId: link.toMemoryItemId, relation: link.relation },
      { fromId: link.toMemoryItemId, toId: link.fromMemoryItemId, relation: link.relation },
    ]);
  }
}
