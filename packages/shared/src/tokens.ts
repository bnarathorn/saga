/**
 * Deterministic token estimation (ADR-0007).
 *
 * Saga serves several agent vendors with different tokenizers, and context-snapshot
 * determinism requires an estimator that never depends on a vocabulary file version.
 * The divisor is tuned against English technical prose plus fenced code and errs slightly
 * high, so budgets stay conservative.
 */
const CHARS_PER_TOKEN = 3.6;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) newlines += 1;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN) + 2 * newlines;
}

/**
 * Truncate to a token budget on a paragraph, then line, then character boundary.
 * Always deterministic for the same input.
 */
export function truncateToTokens(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;

  const paragraphs = text.split('\n\n');
  let kept = '';
  for (const paragraph of paragraphs) {
    const candidate = kept.length === 0 ? paragraph : `${kept}\n\n${paragraph}`;
    if (estimateTokens(candidate) > budget) break;
    kept = candidate;
  }
  if (kept.length > 0) return kept;

  const lines = text.split('\n');
  for (const line of lines) {
    const candidate = kept.length === 0 ? line : `${kept}\n${line}`;
    if (estimateTokens(candidate) > budget) break;
    kept = candidate;
  }
  if (kept.length > 0) return kept;

  // Fall back to a hard character cut, leaving room for the ellipsis marker.
  const maxChars = Math.max(0, Math.floor(budget * CHARS_PER_TOKEN) - 1);
  return maxChars === 0 ? '' : `${text.slice(0, maxChars)}…`;
}
