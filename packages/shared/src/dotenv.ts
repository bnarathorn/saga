import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Minimal `.env` loader. Saga deliberately avoids a dependency here: the file format is
 * `KEY=value`, `#` comments, optional surrounding quotes, and existing process environment
 * always wins so that CI and systemd `EnvironmentFile=` stay authoritative.
 */
/**
 * Walk up from the working directory looking for `.env`, so `pnpm --filter @saga/server dev`
 * (which runs inside `apps/server`) picks up the repository-root file.
 */
function findEnvFile(): string | null {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

export function loadDotEnv(path?: string): void {
  const file = path ?? findEnvFile();
  if (file === null || !existsSync(file)) return;

  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
