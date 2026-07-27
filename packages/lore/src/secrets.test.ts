import { describe, expect, it } from 'vitest';
import { describeFindings, isPlaceholder, scanForSecrets } from './secrets.js';

const clean = { body: 'Start PostgreSQL before starting the API.' };

describe('secret detection', () => {
  it('passes ordinary project knowledge', () => {
    expect(scanForSecrets(clean)).toEqual([]);
    expect(
      scanForSecrets({
        body: 'Run `pnpm test:integration`. It needs TEST_DATABASE_URL and REDIS_URL.',
        data: {
          commands: ['pnpm test:integration'],
          required_environment_variables: ['TEST_DATABASE_URL', 'REDIS_URL'],
        },
      }),
    ).toEqual([]);
  });

  it.each([
    ['a PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA PRIVATE KEY-----', 'pem_private_key'],
    ['an OpenSSH private key', '-----BEGIN OPENSSH PRIVATE KEY-----', 'openssh_private_key'],
    ['an AWS access key id', 'Use AKIAIOSFODNN7EXAMPLE for the uploader.', 'aws_access_key_id'],
    ['a GitHub token', 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_token'],
    ['a Slack token', 'xoxb-1234567890-abcdefghijkl', 'slack_token'],
    ['a Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'google_api_key'],
    ['a Stripe key', 'sk_live_abcdefghijklmnop1234', 'stripe_key'],
    [
      'a JWT',
      'Authorization uses eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'jwt',
    ],
    ['a bearer token', 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345"', 'bearer_token'],
  ])('rejects %s', (_label, body, ruleId) => {
    const findings = scanForSecrets({ body });
    expect(findings.map((finding) => finding.ruleId)).toContain(ruleId);
    expect(findings[0]?.fieldPath).toBe('body');
  });

  it('rejects a credential-bearing connection string', () => {
    const findings = scanForSecrets({ body: 'DATABASE_URL=postgres://saga:hunter2xyz@db:5432/saga' });
    expect(findings.map((finding) => finding.ruleId)).toContain('credential_url');
  });

  it('allows a connection string whose password is clearly a placeholder', () => {
    for (const body of [
      'postgres://saga:${DB_PASSWORD}@db:5432/saga',
      'postgres://saga:<password>@db:5432/saga',
      'postgres://saga:$DB_PASSWORD@db:5432/saga',
      'postgres://saga:changeme@db:5432/saga',
      'postgres://saga:REDACTED@db:5432/saga',
    ]) {
      expect(scanForSecrets({ body }), body).toEqual([]);
    }
  });

  it('rejects a literal password assignment but allows a documented placeholder', () => {
    expect(scanForSecrets({ body: 'password = s3cr3tP4ssw0rd!' }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ body: 'password = ${ADMIN_PASSWORD}' })).toEqual([]);
    expect(scanForSecrets({ body: 'password = <your-password>' })).toEqual([]);
    expect(scanForSecrets({ body: 'The password is stored in the operating-system keychain.' })).toEqual([]);
  });

  it('reports the exact field path inside structured data', () => {
    const findings = scanForSecrets({
      body: 'Deployment procedure.',
      data: {
        steps: ['ssh deploy@host', 'export API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv'],
      },
    });
    // Two rules legitimately fire on the same string — the key's shape and the assignment
    // form. Both must point at the same field so the author has one place to fix.
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(new Set(findings.map((finding) => finding.fieldPath))).toEqual(new Set(['data.steps[1]']));
    expect(findings.map((finding) => finding.ruleId)).toContain('google_api_key');
  });

  it('treats a value in a secret-named field as a secret regardless of shape', () => {
    const findings = scanForSecrets({
      body: 'Service configuration.',
      data: { service: { client_secret: 'not-obviously-random-but-still-a-secret' } },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('high_entropy_secret_field');
    expect(findings[0]?.fieldPath).toBe('data.service.client_secret');
  });

  it('allows an environment-variable reference in a secret-named field', () => {
    expect(
      scanForSecrets({
        body: 'Configuration.',
        data: { client_secret: '${OAUTH_CLIENT_SECRET}', api_key: '<from the keychain>' },
      }),
    ).toEqual([]);
  });

  it('scans evidence as well as the body and data', () => {
    const findings = scanForSecrets({
      body: 'Ordinary knowledge.',
      evidence: [{ path: 'config/prod.env', content_hash: 'sha256:aaa', note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
    });
    expect(findings[0]?.fieldPath).toBe('evidence[0].note');
  });

  it('never includes the secret value in the finding', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const findings = scanForSecrets({ body: `token: ${secret}` });
    const rendered = describeFindings(findings);
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('body contains');
  });

  it('de-duplicates the same rule firing twice in one field', () => {
    const findings = scanForSecrets({
      body: 'AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLX',
    });
    expect(findings.filter((finding) => finding.ruleId === 'aws_access_key_id')).toHaveLength(1);
  });

  it('survives deeply nested and cyclic-looking structures without hanging', () => {
    let nested: Record<string, unknown> = { value: 'safe' };
    for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
    expect(() => scanForSecrets({ body: 'ok', data: nested })).not.toThrow();
  });
});

describe('isPlaceholder', () => {
  it.each(['...', '****', '<value>', '${VAR}', '$VAR', '%VAR%', 'REDACTED', 'changeme', 'your-token'])(
    'treats %s as a placeholder',
    (value) => {
      expect(isPlaceholder(value)).toBe(true);
    },
  );

  it('does not treat a real-looking value as a placeholder', () => {
    expect(isPlaceholder('hunter2-real-value')).toBe(false);
  });
});
