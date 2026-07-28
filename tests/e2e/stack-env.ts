import { existsSync, readFileSync } from 'node:fs';

/**
 * Configuration shared by the Playwright config (which starts the API and Guild Hall) and
 * the global setup (which starts the worker). Kept in one place so the three processes
 * cannot drift onto different databases.
 */

// A tiny inline `.env` reader: this module is evaluated before any workspace package loads.
function envFile(): Record<string, string> {
  if (!existsSync('.env')) return {};
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync('.env', 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    values[line.slice(0, equals).trim()] = line
      .slice(equals + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return values;
}

const dotenv = envFile();
const env = (key: string, fallback = ''): string => process.env[key] ?? dotenv[key] ?? fallback;

export const API_PORT = Number(env('SAGA_E2E_API_PORT', '4419'));
export const WEB_PORT = Number(env('SAGA_E2E_WEB_PORT', '4420'));
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

export const ADMIN_EMAIL = 'e2e-admin@saga.local';
export const ADMIN_PASSWORD = 'e2e-admin-password';

/** Environment for both the API and the worker: same database, same secrets. */
export const stackEnv: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  DATABASE_URL: env('SAGA_E2E_DATABASE_URL', env('SAGA_TEST_DATABASE_URL')),
  SAGA_API_HOST: '127.0.0.1',
  SAGA_API_PORT: String(API_PORT),
  SAGA_PUBLIC_URL: WEB_URL,
  SAGA_SESSION_SECRET: 'e2e-session-secret-that-is-long-enough-0123456789',
  SAGA_COOKIE_SECURE: 'false',
  SAGA_DEV_AUTH_BYPASS: 'false',
  SAGA_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
  SAGA_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
  // The suite drives many requests from one address; the limits have their own API test.
  SAGA_LOGIN_RATE_LIMIT_PER_MINUTE: '10000',
  SAGA_API_RATE_LIMIT_PER_MINUTE: '100000',
  SAGA_EMBEDDING_PROVIDER: 'fake',
  PARTY_MODE: 'advisory',
  // A brisk poll so a job reaches its terminal state while a test is still watching.
  SAGA_WORKER_POLL_INTERVAL_MS: '250',
};
