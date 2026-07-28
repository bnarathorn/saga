const KEY = 'saga.last-project';

/**
 * The project the primary navigation acts on.
 *
 * Spec 1 puts Lore, Quest Board and Party at the top level of Guild Hall, but every one of
 * those views is meaningless without a project — they are per-project resources. Remembering
 * the last project opened lets the top-level entries go somewhere real instead of dead-ending,
 * and the Projects page is the fallback when there is nothing to remember yet.
 */
export function rememberProject(projectRef: string): void {
  if (projectRef.length === 0) return;
  try {
    window.localStorage.setItem(KEY, projectRef);
  } catch {
    // Private browsing or a full quota: the nav falls back to the Projects page.
  }
}

export function lastProject(): string | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === null || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}
