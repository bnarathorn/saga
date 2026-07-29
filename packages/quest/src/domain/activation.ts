import type { ActivationMode, ModeHint, QuestStatus, QuestScope } from '@saga/contracts';

/**
 * Quest matching and activation classification (spec 9.5).
 *
 * The governing rule is asymmetric on purpose: creating an unnecessary Quest is cheap and
 * visible, while resuming the *wrong* Quest silently contaminates a new task with someone
 * else's context. So auto-resume requires both explicit continuation intent and a strong
 * match; anything less returns suggestions and creates new work.
 */

export interface QuestCandidate {
  id: string;
  title: string;
  objective: string | null;
  status: QuestStatus;
  scope: QuestScope;
  lastActivityAt: Date;
  /** Optional semantic similarity in [0,1] from the vector channel. */
  similarity?: number;
}

export interface MatchInput {
  task: string;
  modeHint: ModeHint;
  requestedQuestId: string | null;
  declaredScope: QuestScope | undefined;
  candidates: readonly QuestCandidate[];
  now: Date;
}

export interface ScoredQuest {
  quest: QuestCandidate;
  confidence: number;
  reasons: string[];
}

export interface MatchResult {
  mode: ActivationMode;
  /** The Quest to resume, when the mode is `resume_work`. */
  matched: QuestCandidate | null;
  /** Ranked suggestions the caller may offer without forcing a resume. */
  related: ScoredQuest[];
  /** Human-readable explanation, logged rather than returned to broad audiences. */
  explanation: string;
}

/** Wording that signals the user is continuing existing work rather than starting new work. */
const CONTINUATION_PATTERNS = [
  /\bcontinue\b/i,
  /\bcontinuing\b/i,
  /\bresume\b/i,
  /\bresuming\b/i,
  /\bpick(?:ing)? (?:this|it|that|the \w+) back up\b/i,
  /\bcarry on\b/i,
  /\bwhere (?:i|we) left off\b/i,
  /\bback to\b/i,
  /\bfinish(?:ing)? (?:the|that|this|my)\b/i,
  /\bwrap(?: up)? (?:the|that|this)\b/i,
  /\bstill (?:working|debugging|fixing)\b/i,
];

/** Wording that signals questions or exploration rather than a change to the project. */
const INQUIRY_PATTERNS = [
  /^\s*(?:what|why|how|where|who|when|which|is|are|does|do|can|could|should|would)\b/i,
  /\bexplain\b/i,
  /\bwalk me through\b/i,
  /\bhelp me understand\b/i,
  /\bshow me\b/i,
  /\btell me about\b/i,
  /\breview the architecture\b/i,
  /\bwhat does .* do\b/i,
  /\bjust (?:looking|exploring|browsing|curious)\b/i,
];

/** Wording that clearly signals a change to the project, which outranks inquiry phrasing. */
const IMPLEMENTATION_PATTERNS = [
  /\b(?:add|implement|build|create|write|fix|refactor|migrate|rename|remove|delete|upgrade|bump|patch|revert|deploy|release|optimis[ez]e|rewrite|wire up|hook up|set up)\b/i,
];

const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

export function hasContinuationIntent(task: string): boolean {
  return CONTINUATION_PATTERNS.some((pattern) => pattern.test(task));
}

export function looksLikeInquiry(task: string): boolean {
  // "How do I add X?" is an implementation request phrased as a question.
  if (IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(task))) return false;
  return INQUIRY_PATTERNS.some((pattern) => pattern.test(task));
}

export function extractIssueKeys(task: string): string[] {
  return [...new Set(task.match(ISSUE_KEY_RE) ?? [])];
}

/** Confidence at or above this, plus explicit intent, permits automatic resume. */
export const AUTO_RESUME_THRESHOLD = 0.6;

/** Below this a candidate is not even worth suggesting. */
const SUGGESTION_THRESHOLD = 0.15;

/**
 * Floor for a resume the caller asked for by hint rather than by Quest id. Lower than
 * `AUTO_RESUME_THRESHOLD` because the caller supplied the intent, but not zero: attaching to a
 * Quest too weak to suggest is the "when uncertain" case spec 9.5 says to answer with new work.
 */
export const HINTED_RESUME_THRESHOLD = SUGGESTION_THRESHOLD;

const RESUMABLE: readonly QuestStatus[] = ['open', 'in_progress', 'waiting', 'blocked'];

export function scoreCandidate(
  candidate: QuestCandidate,
  input: Pick<MatchInput, 'task' | 'declaredScope' | 'now'>,
): ScoredQuest {
  const reasons: string[] = [];
  let score = 0;

  const taskLower = input.task.toLowerCase();
  const issueKeys = extractIssueKeys(input.task);
  const candidateIssues = candidate.scope.issue_keys ?? [];

  if (issueKeys.length > 0 && candidateIssues.some((key) => issueKeys.includes(key))) {
    score += 0.5;
    reasons.push('issue key matches');
  }

  // Title overlap on meaningful words only; stop words would match everything.
  const titleWords = significantWords(candidate.title);
  const taskWords = new Set(significantWords(input.task));
  const overlap = titleWords.filter((word) => taskWords.has(word));
  if (titleWords.length > 0) {
    const ratio = overlap.length / titleWords.length;
    if (ratio > 0) {
      score += 0.3 * ratio;
      reasons.push(`title overlap (${overlap.length}/${titleWords.length} words)`);
    }
  }
  if (taskLower.includes(candidate.title.toLowerCase()) && candidate.title.length > 8) {
    score += 0.25;
    reasons.push('task mentions the Quest title');
  }

  const scopeOverlap = countScopeOverlap(candidate.scope, input.declaredScope);
  if (scopeOverlap > 0) {
    score += Math.min(0.3, 0.1 * scopeOverlap);
    reasons.push(`${scopeOverlap} declared scope element(s) in common`);
  }

  if (candidate.similarity !== undefined && candidate.similarity > 0) {
    score += 0.3 * candidate.similarity;
    reasons.push(`semantic similarity ${candidate.similarity.toFixed(2)}`);
  }

  // Recency is a tie-breaker, never evidence on its own.
  const ageHours = (input.now.getTime() - candidate.lastActivityAt.getTime()) / 3_600_000;
  if (ageHours < 24) {
    score += 0.1;
    reasons.push('active in the last day');
  } else if (ageHours > 24 * 30) {
    score -= 0.1;
    reasons.push('dormant for over a month');
  }

  if (candidate.status === 'in_progress') {
    score += 0.05;
    reasons.push('already in progress');
  }

  return { quest: candidate, confidence: clamp(score), reasons };
}

/**
 * Decide how to activate a session.
 *
 * Precedence: an explicit Quest id, then an explicit mode hint, then classification.
 */
export function classifyActivation(input: MatchInput): MatchResult {
  const scored = input.candidates
    .map((candidate) => scoreCandidate(candidate, input))
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.quest.lastActivityAt.getTime() - a.quest.lastActivityAt.getTime() ||
        a.quest.id.localeCompare(b.quest.id),
    );
  const related = scored.filter((entry) => entry.confidence >= SUGGESTION_THRESHOLD).slice(0, 5);

  if (input.requestedQuestId !== null) {
    const requested = input.candidates.find((candidate) => candidate.id === input.requestedQuestId);
    if (requested !== undefined) {
      return {
        mode: 'resume_work',
        matched: requested,
        related: related.filter((entry) => entry.quest.id !== requested.id),
        explanation: 'The caller named the Quest explicitly.',
      };
    }
    // A named-but-unavailable Quest falls through to classification rather than failing:
    // it may be completed, archived, or in another project.
  }

  if (input.modeHint === 'inquiry') {
    return {
      mode: 'inquiry',
      matched: null,
      related,
      explanation: 'The caller asked for inquiry mode.',
    };
  }
  if (input.modeHint === 'new_work') {
    return {
      mode: 'new_work',
      matched: null,
      related,
      explanation: 'The caller asked for new work.',
    };
  }
  if (input.modeHint === 'resume_work') {
    const best = scored[0];
    // The hint supplies the "continuation intent is explicit" half of spec 9.5, but not the
    // "confidence is high" half. A hint used to attach the top candidate whatever it scored,
    // so a resume in a project with one unrelated open Quest silently joined that Quest. The
    // floor is the suggestion threshold rather than the automatic one: the caller has said
    // what they mean, so a weaker match is enough — but not a match too weak to even suggest.
    if (
      best !== undefined &&
      best.confidence >= HINTED_RESUME_THRESHOLD &&
      RESUMABLE.includes(best.quest.status)
    ) {
      return {
        mode: 'resume_work',
        matched: best.quest,
        related: related.filter((entry) => entry.quest.id !== best.quest.id),
        explanation: `The caller asked to resume; the best match was "${best.quest.title}" at ${best.confidence.toFixed(2)}.`,
      };
    }
    return {
      mode: 'new_work',
      matched: null,
      related,
      explanation:
        best === undefined
          ? 'The caller asked to resume, but the project has no open Quest to resume.'
          : `The caller asked to resume, but the best match "${best.quest.title}" scored only ${best.confidence.toFixed(2)}. Spec 9.5: when uncertain, create a new Quest and offer suggestions. Name the Quest explicitly to resume it anyway.`,
    };
  }

  // --- automatic classification -------------------------------------------

  if (looksLikeInquiry(input.task)) {
    return {
      mode: 'inquiry',
      matched: null,
      related,
      explanation: 'The task reads as a question rather than a change to the project.',
    };
  }

  const best = scored[0];
  const explicitIntent = hasContinuationIntent(input.task);

  if (
    explicitIntent &&
    best !== undefined &&
    best.confidence >= AUTO_RESUME_THRESHOLD &&
    RESUMABLE.includes(best.quest.status)
  ) {
    return {
      mode: 'resume_work',
      matched: best.quest,
      related: related.filter((entry) => entry.quest.id !== best.quest.id),
      explanation: `Continuation intent plus a strong match on "${best.quest.title}" (${best.confidence.toFixed(2)}).`,
    };
  }

  return {
    mode: 'new_work',
    matched: null,
    related,
    explanation:
      best === undefined
        ? 'No existing Quest to match against.'
        : explicitIntent
          ? `Continuation intent, but the best match "${best.quest.title}" scored only ${best.confidence.toFixed(2)}; creating new work and offering suggestions instead.`
          : `No explicit continuation intent; creating new work. Best related Quest scored ${best.confidence.toFixed(2)}.`,
  };
}

/** A concise title for a Quest created from the user's first task. */
export const UNTITLED_QUEST = 'Untitled task';

export function deriveQuestTitle(task: string, maxLength = 120): string {
  const firstSentence = task.split(/(?<=[.!?])\s|\n/)[0] ?? task;
  const cleaned = firstSentence
    .replace(/^\s*(?:please\s+|can you\s+|could you\s+|i(?:'d| would) like (?:you )?to\s+)/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const titled = cleaned.length === 0 ? task.trim().slice(0, maxLength) : cleaned;
  const withoutTrailingPunctuation = titled.replace(/[.!?]+$/, '');
  // A task of only whitespace or punctuation ("???") strips down to nothing, and
  // `work_items_title_not_blank` would then reject the insert with a raw constraint violation
  // instead of a domain error. A Quest always gets a title; the task text is kept in
  // `sessions.initial_task` regardless.
  if (withoutTrailingPunctuation.trim().length === 0) return UNTITLED_QUEST;
  if (withoutTrailingPunctuation.length <= maxLength) {
    return capitalize(withoutTrailingPunctuation);
  }
  const truncated = withoutTrailingPunctuation.slice(0, maxLength - 1);
  const lastSpace = truncated.lastIndexOf(' ');
  return capitalize(`${lastSpace > maxLength / 2 ? truncated.slice(0, lastSpace) : truncated}…`);
}

// --- helpers ---------------------------------------------------------------

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'this',
  'that',
  'these',
  'those',
  'i',
  'we',
  'you',
  'my',
  'our',
  'your',
  'add',
  'fix',
  'make',
  'use',
  'using',
  'need',
  'want',
  'please',
  'can',
  'could',
  'should',
  'would',
  'will',
  'do',
  'does',
  'did',
  'get',
  'set',
]);

export function significantWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.-]+/u)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
    ),
  ];
}

function countScopeOverlap(a: QuestScope, b: QuestScope | undefined): number {
  if (b === undefined) return 0;
  let count = 0;
  const fields: (keyof QuestScope)[] = [
    'modules',
    'components',
    'apis',
    'databases',
    'files',
    'issue_keys',
  ];
  for (const field of fields) {
    const left = new Set(a[field] ?? []);
    for (const value of b[field] ?? []) {
      if (left.has(value)) count += 1;
    }
  }
  return count;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(4))));
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
