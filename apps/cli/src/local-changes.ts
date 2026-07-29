/**
 * What the CLI has written to disk during this process (spec 13.5).
 *
 * The error contract requires every failure to say whether local work is safe. Saying "your
 * local files were not modified" after `connect` has already written `.saga/project.yaml`,
 * `config.json` or an MCP file is worse than saying nothing: it tells the user not to look at
 * files that have in fact changed. Every write records itself here, and the top-level handler
 * reports what actually happened.
 */

const written = new Set<string>();

export function noteLocalChange(path: string): void {
  written.add(path);
}

export function localChanges(): string[] {
  return [...written];
}

/** Test seam. Never called by the CLI itself: the process is the lifetime of the record. */
export function resetLocalChanges(): void {
  written.clear();
}

/**
 * The sentence that belongs under a CLI error, given what has been written so far. Files are
 * named rather than counted, because the user's next move is to look at them.
 */
export function describeLocalChanges(): string {
  const paths = localChanges();
  if (paths.length === 0) return 'Your local files were not modified.';
  return (
    `These local files were already written before the failure:\n` +
    paths.map((path) => `    ${path}`).join('\n') +
    `\n  Nothing else was touched, and re-running the command overwrites them safely.`
  );
}
