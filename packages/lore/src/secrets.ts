/**
 * Lore secret policy.
 *
 * This is stricter than the logging redactor in `@saga/shared`: a candidate Lore version that
 * contains a credential is *rejected*, not quietly cleaned, because Saga would otherwise
 * become a durable, searchable, replicated store of secrets. The error names the field path
 * that tripped the policy and never echoes the value.
 */

export type SecretRuleId =
  | 'pem_private_key'
  | 'openssh_private_key'
  | 'aws_access_key_id'
  | 'aws_secret_access_key'
  | 'github_token'
  | 'slack_token'
  | 'google_api_key'
  | 'stripe_key'
  | 'jwt'
  | 'bearer_token'
  | 'credential_url'
  | 'private_key_assignment'
  | 'password_assignment'
  | 'secret_assignment'
  | 'high_entropy_secret_field';

export interface SecretRule {
  id: SecretRuleId;
  description: string;
  pattern: RegExp;
}

/**
 * Order matters only for reporting: the first match wins, so the most specific and most
 * recognisable rules come first.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'pem_private_key',
    description: 'a PEM private-key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    id: 'openssh_private_key',
    description: 'an OpenSSH private key',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/,
  },
  {
    id: 'aws_access_key_id',
    description: 'an AWS access key id',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'github_token',
    description: 'a GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
  {
    id: 'slack_token',
    description: 'a Slack token',
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'google_api_key',
    description: 'a Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'stripe_key',
    description: 'a Stripe secret key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/,
  },
  {
    id: 'jwt',
    description: 'a JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    id: 'bearer_token',
    description: 'a bearer token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i,
  },
  {
    id: 'credential_url',
    description: 'a password embedded in a connection string',
    // A URL with a non-placeholder password. Documentation placeholders are allowed so a
    // Lore Entry can still show the *shape* of a connection string.
    pattern:
      /\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:(?!(?:\.{3}|\*{3,}|x{3,}|X{3,}|<[^>]{1,40}>|\$\{[^}]{1,60}\}|\$[A-Z_]{3,40}|%[A-Z_]{3,40}%|redacted|REDACTED|password|PASSWORD|changeme|CHANGEME|your[-_]?password)[@\s])[^@\s/]{3,}@/,
  },
  {
    id: 'aws_secret_access_key',
    description: 'an AWS secret access key',
    pattern: /\baws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}\b/i,
  },
  {
    id: 'private_key_assignment',
    description: 'a private key assignment',
    pattern: /\b(?:private[_-]?key|signing[_-]?key)\s*[=:]\s*["']?[A-Za-z0-9/+=_-]{16,}/i,
  },
  {
    id: 'password_assignment',
    description: 'a literal password assignment',
    pattern:
      /\b(?:password|passwd|pwd)\s*[=:]\s*["']?(?!(?:\.{3}|\*{3,}|<[^>]{1,40}>|\$\{[^}]{1,60}\}|\$[A-Z_]{3,40}|%[A-Z_]{3,40}%|redacted|REDACTED|changeme|CHANGEME|your[-_]?password|\s|$))[^\s"',;]{8,}/i,
  },
  {
    id: 'secret_assignment',
    description: 'a literal secret or token assignment',
    pattern:
      /\b(?:secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|session[_-]?secret|client[_-]?secret)\s*[=:]\s*["']?(?!(?:\.{3}|\*{3,}|<[^>]{1,40}>|\$\{[^}]{1,60}\}|\$[A-Z_]{3,40}|%[A-Z_]{3,40}%|redacted|REDACTED|changeme|CHANGEME|\s|$))[A-Za-z0-9/+=_-]{16,}/i,
  },
];

/** Field names whose *value* is treated as a secret regardless of its shape. */
const SECRET_FIELD_NAMES =
  /^(password|passwd|pwd|secret|api_key|apikey|access_token|refresh_token|auth_token|session_secret|client_secret|private_key|signing_key|token|credentials?)$/i;

export interface SecretFinding {
  ruleId: SecretRuleId;
  description: string;
  /** Where it was found, e.g. `body`, `data.commands[2]`, `evidence[0].path`. */
  fieldPath: string;
}

export interface SecretScanInput {
  body: string;
  data?: unknown;
  evidence?: unknown;
}

const MIN_SECRET_FIELD_LENGTH = 12;

/**
 * Scan a candidate Lore version. Returns every finding rather than stopping at the first, so
 * the author can fix a whole entry in one pass.
 */
export function scanForSecrets(input: SecretScanInput): SecretFinding[] {
  const findings: SecretFinding[] = [];

  scanText(input.body, 'body', findings);
  if (input.data !== undefined) walk(input.data, 'data', findings);
  if (input.evidence !== undefined) walk(input.evidence, 'evidence', findings);

  // De-duplicate: the same rule firing twice in one field is one problem to fix.
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.ruleId}@${finding.fieldPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanText(value: string, fieldPath: string, findings: SecretFinding[]): void {
  for (const rule of SECRET_RULES) {
    if (rule.pattern.test(value)) {
      findings.push({ ruleId: rule.id, description: rule.description, fieldPath });
    }
  }
}

function walk(value: unknown, path: string, findings: SecretFinding[], depth = 0): void {
  if (depth > 12) return;

  if (typeof value === 'string') {
    scanText(value, path, findings);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, findings, depth + 1));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    // A field literally named `password` holding a non-trivial value is a secret whatever
    // its shape; placeholders and environment-variable references stay allowed so an entry
    // can still document which variables exist.
    if (
      SECRET_FIELD_NAMES.test(key) &&
      typeof item === 'string' &&
      item.length >= MIN_SECRET_FIELD_LENGTH &&
      !isPlaceholder(item)
    ) {
      findings.push({
        ruleId: 'high_entropy_secret_field',
        description: `a value in a field named "${key}"`,
        fieldPath: childPath,
      });
      continue;
    }
    walk(item, childPath, findings, depth + 1);
  }
}

const PLACEHOLDER_RE =
  /^(?:\.{3}|\*+|x+|X+|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|%[A-Z_]+%|redacted|REDACTED|\[redacted\]|changeme|CHANGEME|your[-_]?\w+|example|EXAMPLE|placeholder|PLACEHOLDER|null|none|n\/a)$/;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value.trim());
}

export function describeFindings(findings: readonly SecretFinding[]): string {
  const parts = findings.map((finding) => `${finding.fieldPath} contains ${finding.description}`);
  return parts.join('; ');
}
