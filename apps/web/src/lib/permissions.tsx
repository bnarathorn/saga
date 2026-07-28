import type { Permission } from '@saga/contracts';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * What the signed-in caller may do, as reported by `/api/auth/me`. Guild Hall hides actions
 * the caller cannot perform; the API checks the same permissions on every request, so a
 * hidden control is a refused request, never merely a hidden one.
 */
const PermissionContext = createContext<ReadonlySet<Permission>>(new Set<Permission>());

export function PermissionProvider({
  permissions,
  children,
}: {
  permissions: readonly Permission[];
  children: ReactNode;
}) {
  const value = useMemo(() => new Set(permissions), [permissions]);
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

/** `const can = useCan(); can('shrine:operate')` */
export function useCan(): (permission: Permission) => boolean {
  const permissions = useContext(PermissionContext);
  return useMemo(() => (permission: Permission) => permissions.has(permission), [permissions]);
}

/** Explains an absent control, so a viewer is told why rather than left guessing. */
export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs text-ink-500 dark:text-parchment-300/70">
      {children ?? 'Your role has read-only access here.'}
    </p>
  );
}
