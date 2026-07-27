import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

const PACKAGES = 'shared|contracts|database|core|shrine|quest|lore|party|agent-sdk';

/**
 * Tests always run against TypeScript sources rather than build output so that a
 * stale `dist/` can never mask a regression.
 */
export const sagaAliases = [
  {
    find: new RegExp(`^@saga/(${PACKAGES})$`),
    replacement: `${root}/packages/$1/src/index.ts`,
  },
  {
    find: new RegExp(`^@saga/(${PACKAGES})/(.*)$`),
    replacement: `${root}/packages/$1/src/$2.ts`,
  },
];
