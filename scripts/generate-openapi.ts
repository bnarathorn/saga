#!/usr/bin/env tsx
/**
 * Generate `docs/openapi.json` from the shared Zod contracts.
 *
 * `--check` fails when the committed document is stale, so CI catches contract drift rather
 * than shipping documentation that disagrees with the API.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '@saga/contracts/openapi';

const OUTPUT = fileURLToPath(new URL('../docs/openapi.json', import.meta.url));

const document = buildOpenApiDocument(process.env.SAGA_VERSION ?? '0.1.0');
const rendered = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(OUTPUT)) {
    console.error('docs/openapi.json is missing. Run: pnpm openapi:generate');
    process.exit(1);
  }
  const committed = readFileSync(OUTPUT, 'utf8');
  if (committed !== rendered) {
    console.error(
      'docs/openapi.json is out of date with the Zod contracts. Run: pnpm openapi:generate',
    );
    process.exit(1);
  }
  console.log(`docs/openapi.json is up to date (${Object.keys(document.paths ?? {}).length} paths).`);
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, rendered);
  console.log(
    `wrote docs/openapi.json (${Object.keys((document as { paths?: object }).paths ?? {}).length} paths)`,
  );
}
