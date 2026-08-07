import { MEMORY_RELATIONS, type MemoryRelation } from '@saga/contracts';
import { SagaError } from '@saga/shared';

/** One entry, as the model sees it. */
export interface RelationSubject {
  memoryKey: string;
  body: string;
}

/** One relation the model believes holds, always directed away from the subject. */
export interface ProposedRelation {
  toMemoryKey: string;
  relation: MemoryRelation;
  confidence: number;
  rationale: string;
}

export interface RelationProposer {
  readonly name: string;
  /**
   * Judge which of `candidates` the `subject` actually relates to, and how. Returning fewer
   * than were offered — including none — is the expected outcome, not a failure.
   */
  propose(
    subject: RelationSubject,
    candidates: readonly RelationSubject[],
  ): Promise<ProposedRelation[]>;
}

/**
 * The default. Proposes nothing, so a stock install and CI run the job end to end without a
 * model server: the deterministic half still writes its relations and the model half is a
 * no-op. Silence is a legitimate answer here, which is what makes this a usable default
 * rather than a stub.
 */
export class NullRelationProposer implements RelationProposer {
  readonly name = 'fake';

  async propose(): Promise<ProposedRelation[]> {
    return [];
  }
}

export interface OllamaProposerOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Bodies are truncated to this before the prompt is built. */
  maxBodyChars?: number;
}

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

const INSTRUCTIONS = `You label relations between entries in a project knowledge base.

Given a SUBJECT entry and several CANDIDATE entries, decide which candidates the subject has a
real, directed relation to. The relation must be stated or clearly implied by the subject's own
text — not merely plausible because the two entries are about similar things.

Allowed relations, all directed from the subject to the candidate:
${MEMORY_RELATIONS.map((relation) => `- ${relation}`).join('\n')}

Rules:
- Omit any candidate you are not confident about. Returning an empty list is correct and common.
- Never invent a memory key. Use the candidate keys exactly as given.
- confidence is 0..1 and is your own estimate.
- rationale is one short sentence quoting or paraphrasing the subject text that justifies it.

Answer with JSON only, in this shape:
{"relations":[{"to_memory_key":"...","relation":"...","confidence":0.0,"rationale":"..."}]}`;

/**
 * Ollama's `/api/generate` in JSON mode.
 *
 * Everything the model returns is treated as untrusted: unknown keys, relations outside the
 * enum, out-of-range confidences and self-links are dropped rather than corrected. A model
 * that answers badly should propose less, never propose something the schema would reject at
 * insert time.
 */
export class OllamaRelationProposer implements RelationProposer {
  readonly name = 'ollama';

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxBodyChars: number;

  constructor(options: OllamaProposerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxBodyChars = options.maxBodyChars ?? 1_500;
  }

  async propose(
    subject: RelationSubject,
    candidates: readonly RelationSubject[],
  ): Promise<ProposedRelation[]> {
    if (candidates.length === 0) return [];

    const prompt = this.buildPrompt(subject, candidates);

    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          format: 'json',
          // Deterministic-ish: the same publish re-running should not churn the review queue.
          options: { temperature: 0 },
        }),
      });
    } catch (error) {
      throw new SagaError(
        'INFERENCE_PROVIDER_UNAVAILABLE',
        `Could not reach the inference provider at ${this.baseUrl}.`,
        { cause: error, retryable: true },
      );
    }

    if (!response.ok) {
      throw new SagaError(
        'INFERENCE_PROVIDER_UNAVAILABLE',
        `The inference provider answered ${response.status}.`,
        { retryable: true, details: { status: response.status } },
      );
    }

    const body = (await response.json()) as OllamaGenerateResponse;
    if (typeof body.response !== 'string') {
      throw new SagaError(
        'INFERENCE_PROVIDER_UNAVAILABLE',
        'The inference provider returned no completion.',
        { retryable: true },
      );
    }

    const allowed = new Set(candidates.map((candidate) => candidate.memoryKey));
    return parseProposals(body.response, allowed, subject.memoryKey);
  }

  private buildPrompt(subject: RelationSubject, candidates: readonly RelationSubject[]): string {
    const clip = (text: string): string =>
      text.length <= this.maxBodyChars ? text : `${text.slice(0, this.maxBodyChars)}…`;

    const rendered = candidates
      .map((candidate) => `### ${candidate.memoryKey}\n${clip(candidate.body)}`)
      .join('\n\n');

    return `${INSTRUCTIONS}

SUBJECT
### ${subject.memoryKey}
${clip(subject.body)}

CANDIDATES
${rendered}`;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pull proposals out of whatever the model produced.
 *
 * Exported for its tests, and deliberately total: a malformed answer yields no proposals rather
 * than an exception, because one bad completion must not fail a job whose deterministic half
 * already succeeded.
 */
export function parseProposals(
  completion: string,
  allowedKeys: ReadonlySet<string>,
  subjectKey: string,
): ProposedRelation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(completion);
  } catch {
    return [];
  }

  const relations = (parsed as { relations?: unknown } | null)?.relations;
  if (!Array.isArray(relations)) return [];

  const relationSet = new Set<string>(MEMORY_RELATIONS);
  const seen = new Set<string>();
  const accepted: ProposedRelation[] = [];

  for (const entry of relations) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const toMemoryKey = row.to_memory_key;
    const relation = row.relation;
    const confidence = row.confidence;
    const rationale = row.rationale;

    if (typeof toMemoryKey !== 'string' || !allowedKeys.has(toMemoryKey)) continue;
    // The subject may not be among the candidates, but a model can still name it.
    if (toMemoryKey === subjectKey) continue;
    if (typeof relation !== 'string' || !relationSet.has(relation)) continue;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) continue;
    if (confidence < 0 || confidence > 1) continue;
    if (seen.has(toMemoryKey)) continue;

    seen.add(toMemoryKey);
    accepted.push({
      toMemoryKey,
      relation: relation as MemoryRelation,
      confidence,
      rationale: typeof rationale === 'string' ? rationale.trim().slice(0, 500) : '',
    });
  }

  return accepted;
}

export interface RelationProposerConfig {
  provider: 'fake' | 'ollama';
  model: string;
  ollamaUrl: string;
  timeoutMs: number;
}

export function createRelationProposer(config: RelationProposerConfig): RelationProposer {
  if (config.provider === 'ollama') {
    return new OllamaRelationProposer({
      baseUrl: config.ollamaUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });
  }
  return new NullRelationProposer();
}
