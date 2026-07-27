import type {
  EvidenceItem,
  MemoryCategory,
  MemoryKind,
  MemoryRelation,
  MemoryState,
  MemoryUpdateState,
  VerificationState,
  Volatility,
} from '@saga/contracts';

export type EmbeddingState = 'queued' | 'claimed' | 'ready' | 'failed';

export interface MemoryItem {
  id: string;
  projectId: string;
  memoryKey: string;
  category: MemoryCategory;
  kind: MemoryKind;
  state: MemoryState;
  importance: number;
  volatility: Volatility;
  currentVersionId: string | null;
  lastVerifiedAt: Date | null;
  staleReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryVersion {
  id: string;
  memoryItemId: string;
  memoryUpdateId: string | null;
  baseVersionId: string | null;
  body: string;
  data: Record<string, unknown>;
  evidence: EvidenceItem[];
  contentHash: string;
  confidence: number;
  verificationState: VerificationState;
  embeddingState: EmbeddingState;
  embeddingModel: string | null;
  createdBySessionId: string | null;
  createdAt: Date;
  readyAt: Date | null;
}

export interface MemoryItemWithVersion extends MemoryItem {
  currentVersion: MemoryVersion | null;
}

export interface MemoryUpdate {
  id: string;
  projectId: string;
  createdBySessionId: string | null;
  state: MemoryUpdateState;
  summary: string;
  error: string | null;
  createdAt: Date;
  validatingAt: Date | null;
  readyAt: Date | null;
  publishedAt: Date | null;
  cancelledAt: Date | null;
  preparedSnapshotId: string | null;
  correlationId: string | null;
}

export interface MemoryUpdateItem {
  memoryUpdateId: string;
  memoryItemId: string;
  memoryKey: string;
  baseVersionId: string | null;
  candidateVersionId: string;
}

export interface MemoryLink {
  id: string;
  projectId: string;
  fromMemoryItemId: string;
  fromMemoryKey: string;
  relation: MemoryRelation;
  toMemoryItemId: string;
  toMemoryKey: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export type SnapshotState = 'building' | 'ready' | 'active' | 'failed';

export interface ContextSnapshot {
  id: string;
  projectId: string;
  projectRevision: number;
  state: SnapshotState;
  sections: ContextSection[];
  renderedContext: string;
  tokenCount: number;
  error: string | null;
  createdAt: Date;
  readyAt: Date | null;
  activatedAt: Date | null;
}

export interface ContextSectionEntry {
  memoryKey: string;
  body: string;
  state: MemoryState;
  verificationState: VerificationState;
  staleReason: string | null;
}

export interface ContextSection {
  id: string;
  title: string;
  entries: ContextSectionEntry[];
}

/**
 * The state machine a Lore update walks. Transitions live in `LoreService`; nothing else may
 * move an update between states.
 */
export const UPDATE_TRANSITIONS: Record<MemoryUpdateState, readonly MemoryUpdateState[]> = {
  draft: ['validating', 'cancelled', 'failed'],
  validating: ['ready', 'failed', 'cancelled'],
  ready: ['published', 'conflict', 'cancelled', 'failed'],
  published: [],
  conflict: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: MemoryUpdateState, to: MemoryUpdateState): boolean {
  return UPDATE_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: MemoryUpdateState): boolean {
  return UPDATE_TRANSITIONS[state].length === 0;
}
