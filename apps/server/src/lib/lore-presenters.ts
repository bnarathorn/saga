import type {
  BootstrapPlan,
  ContextSnapshotDto,
  LoreEntryDto,
  MemoryLinkDto,
  MemoryUpdateDto,
  MemoryVersionDto,
} from '@saga/contracts';
import type {
  ContextSnapshot,
  MemoryItemWithVersion,
  MemoryLink,
  MemoryVersion,
  UpdateWithItems,
} from '@saga/lore';
import { bootstrapPlan } from '@saga/lore';
import { toIso, toIsoRequired } from '@saga/shared';

export function presentMemoryVersion(version: MemoryVersion): MemoryVersionDto {
  return {
    id: version.id,
    memory_item_id: version.memoryItemId,
    base_version_id: version.baseVersionId,
    body: version.body,
    data: version.data,
    evidence: version.evidence as unknown as Record<string, unknown>[],
    content_hash: version.contentHash,
    confidence: version.confidence,
    verification_state: version.verificationState,
    embedding_state: version.embeddingState,
    embedding_model: version.embeddingModel,
    created_at: toIsoRequired(version.createdAt),
    ready_at: toIso(version.readyAt),
  };
}

export function presentLoreEntry(item: MemoryItemWithVersion): LoreEntryDto {
  return {
    id: item.id,
    project_id: item.projectId,
    memory_key: item.memoryKey,
    category: item.category,
    kind: item.kind,
    state: item.state,
    importance: item.importance,
    volatility: item.volatility,
    current_version:
      item.currentVersion === null ? null : presentMemoryVersion(item.currentVersion),
    last_verified_at: toIso(item.lastVerifiedAt),
    stale_reason: item.staleReason,
    created_at: toIsoRequired(item.createdAt),
    updated_at: toIsoRequired(item.updatedAt),
  };
}

export function presentLoreUpdate(detail: UpdateWithItems): MemoryUpdateDto {
  const { update, items } = detail;
  return {
    id: update.id,
    project_id: update.projectId,
    state: update.state,
    summary: update.summary,
    error: update.error,
    created_at: toIsoRequired(update.createdAt),
    validating_at: toIso(update.validatingAt),
    ready_at: toIso(update.readyAt),
    published_at: toIso(update.publishedAt),
    cancelled_at: toIso(update.cancelledAt),
    prepared_snapshot_id: update.preparedSnapshotId,
    items: items.map((item) => ({
      memory_item_id: item.memoryItemId,
      memory_key: item.memoryKey,
      base_version_id: item.baseVersionId,
      candidate_version_id: item.candidateVersionId,
      candidate: presentMemoryVersion(item.candidate),
      conflicted: item.conflicted,
    })),
  };
}

export function presentMemoryLink(link: MemoryLink): MemoryLinkDto {
  return {
    id: link.id,
    from_memory_key: link.fromMemoryKey,
    relation: link.relation,
    to_memory_key: link.toMemoryKey,
    metadata: link.metadata,
    created_at: toIsoRequired(link.createdAt),
  };
}

export function presentSnapshot(snapshot: ContextSnapshot): ContextSnapshotDto {
  return {
    id: snapshot.id,
    project_id: snapshot.projectId,
    project_revision: snapshot.projectRevision,
    state: snapshot.state,
    token_count: snapshot.tokenCount,
    rendered_context: snapshot.renderedContext,
    sections: snapshot.sections.map((section) => ({
      id: section.id,
      title: section.title,
      entries: section.entries.map((entry) => ({
        memory_key: entry.memoryKey,
        body: entry.body,
        state: entry.state,
        verification_state: entry.verificationState,
        stale_reason: entry.staleReason,
      })),
    })),
    error: snapshot.error,
    created_at: toIsoRequired(snapshot.createdAt),
    ready_at: toIso(snapshot.readyAt),
    activated_at: toIso(snapshot.activatedAt),
  };
}

export function presentBootstrapPlan(required: boolean): BootstrapPlan {
  return bootstrapPlan(required);
}
