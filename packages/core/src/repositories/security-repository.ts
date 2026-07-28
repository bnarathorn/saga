import type { AgentScope, UserRole } from '@saga/contracts';
import type { Queryable } from '@saga/database';
import { isUniqueViolation } from '@saga/database';
import { SagaError } from '@saga/shared';

// --- users -----------------------------------------------------------------

export interface UserRecord {
  id: string;
  email: string;
  emailKey: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  state: 'active' | 'disabled';
  failedAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  email_key: string;
  display_name: string;
  password_hash: string;
  role: string;
  state: string;
  failed_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

const USER_COLUMNS = `id, email, email_key, display_name, password_hash, role, state,
                      failed_attempts, locked_until, last_login_at, created_at`;

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    emailKey: row.email_key,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role as UserRole,
    state: row.state as 'active' | 'disabled',
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

export class UserRepository {
  async create(
    q: Queryable,
    input: { email: string; displayName: string; passwordHash: string; role: UserRole },
  ): Promise<UserRecord> {
    try {
      const result = await q.query<UserRow>(
        `INSERT INTO security.users (email, email_key, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${USER_COLUMNS}`,
        [
          input.email.trim(),
          normalizeEmail(input.email),
          input.displayName,
          input.passwordHash,
          input.role,
        ],
      );
      return toUser(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key_uniq')) {
        throw new SagaError('CONFLICT', 'A user with that email address already exists.');
      }
      throw error;
    }
  }

  async findByEmail(q: Queryable, email: string): Promise<UserRecord | null> {
    const result = await q.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM security.users WHERE email_key = $1`,
      [normalizeEmail(email)],
    );
    return result.rows[0] === undefined ? null : toUser(result.rows[0]);
  }

  async findById(q: Queryable, id: string): Promise<UserRecord | null> {
    const result = await q.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM security.users WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toUser(result.rows[0]);
  }

  async recordFailedLogin(q: Queryable, id: string, lockedUntil: Date | null): Promise<void> {
    await q.query(
      `UPDATE security.users
          SET failed_attempts = failed_attempts + 1, locked_until = $2, updated_at = now()
        WHERE id = $1`,
      [id, lockedUntil],
    );
  }

  async recordSuccessfulLogin(q: Queryable, id: string): Promise<void> {
    await q.query(
      `UPDATE security.users
          SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  async count(q: Queryable): Promise<number> {
    const result = await q.query<{ count: string }>(`SELECT count(*)::text FROM security.users`);
    return Number(result.rows[0]!.count);
  }
}

// --- web sessions ----------------------------------------------------------

export interface WebSessionRecord {
  id: string;
  userId: string;
  csrfTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export class WebSessionRepository {
  async create(
    q: Queryable,
    input: {
      userId: string;
      sessionHash: string;
      csrfTokenHash: string;
      userAgent: string | null;
      ipAddress: string | null;
      expiresAt: Date;
    },
  ): Promise<string> {
    const result = await q.query<{ id: string }>(
      `INSERT INTO security.web_sessions
         (user_id, session_hash, csrf_token_hash, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5::inet, $6) RETURNING id`,
      [
        input.userId,
        input.sessionHash,
        input.csrfTokenHash,
        input.userAgent,
        input.ipAddress,
        input.expiresAt,
      ],
    );
    return result.rows[0]!.id;
  }

  /** Resolve a live session and refresh `last_seen_at` in the same round trip. */
  async touch(
    q: Queryable,
    sessionHash: string,
  ): Promise<(WebSessionRecord & { user: UserRecord }) | null> {
    const result = await q.query<
      {
        id: string;
        user_id: string;
        csrf_token_hash: string;
        expires_at: Date;
        revoked_at: Date | null;
      } & UserRow
    >(
      `UPDATE security.web_sessions s
          SET last_seen_at = now()
         FROM security.users u
        WHERE s.session_hash = $1
          AND s.user_id = u.id
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.state = 'active'
      RETURNING s.id, s.user_id, s.csrf_token_hash, s.expires_at, s.revoked_at,
                u.email, u.email_key, u.display_name, u.password_hash, u.role, u.state,
                u.failed_attempts, u.locked_until, u.last_login_at, u.created_at`,
      [sessionHash],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      userId: row.user_id,
      csrfTokenHash: row.csrf_token_hash,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      user: toUser({ ...row, id: row.user_id }),
    };
  }

  async revoke(q: Queryable, sessionHash: string): Promise<void> {
    await q.query(
      `UPDATE security.web_sessions SET revoked_at = now()
        WHERE session_hash = $1 AND revoked_at IS NULL`,
      [sessionHash],
    );
  }

  async revokeAllForUser(q: Queryable, userId: string): Promise<void> {
    await q.query(
      `UPDATE security.web_sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  async deleteExpiredBefore(q: Queryable, before: Date): Promise<number> {
    const result = await q.query(`DELETE FROM security.web_sessions WHERE expires_at < $1`, [
      before,
    ]);
    return result.rowCount ?? 0;
  }
}

// --- agent tokens ----------------------------------------------------------

export interface AgentTokenRecord {
  id: string;
  projectId: string;
  name: string;
  tokenPrefix: string;
  scopes: AgentScope[];
  client: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

interface AgentTokenRow {
  id: string;
  project_id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  client: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const TOKEN_COLUMNS = `id, project_id, name, token_prefix, scopes, client, created_at,
                       last_used_at, expires_at, revoked_at`;

function toToken(row: AgentTokenRow): AgentTokenRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes as AgentScope[],
    client: row.client,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class AgentTokenRepository {
  async create(
    q: Queryable,
    input: {
      projectId: string;
      createdBy: string | null;
      name: string;
      tokenHash: string;
      tokenPrefix: string;
      scopes: readonly AgentScope[];
      client: string | null;
      expiresAt: Date | null;
    },
  ): Promise<AgentTokenRecord> {
    const result = await q.query<AgentTokenRow>(
      `INSERT INTO security.agent_tokens
         (project_id, created_by, name, token_hash, token_prefix, scopes, client, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8)
       RETURNING ${TOKEN_COLUMNS}`,
      [
        input.projectId,
        input.createdBy,
        input.name,
        input.tokenHash,
        input.tokenPrefix,
        [...input.scopes],
        input.client,
        input.expiresAt,
      ],
    );
    return toToken(result.rows[0]!);
  }

  /**
   * Look up a token by hash and stamp `last_used_at`. Revoked and expired tokens are filtered
   * in SQL so an unusable token never reaches the authorization layer.
   */
  async authenticate(q: Queryable, tokenHash: string): Promise<AgentTokenRecord | null> {
    const result = await q.query<AgentTokenRow>(
      `UPDATE security.agent_tokens
          SET last_used_at = now()
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
       RETURNING ${TOKEN_COLUMNS}`,
      [tokenHash],
    );
    return result.rows[0] === undefined ? null : toToken(result.rows[0]);
  }

  async listForProject(q: Queryable, projectId: string): Promise<AgentTokenRecord[]> {
    const result = await q.query<AgentTokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM security.agent_tokens
        WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId],
    );
    return result.rows.map(toToken);
  }

  async revoke(
    q: Queryable,
    id: string,
    revokedBy: string | null,
  ): Promise<AgentTokenRecord | null> {
    const result = await q.query<AgentTokenRow>(
      `UPDATE security.agent_tokens SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL RETURNING ${TOKEN_COLUMNS}`,
      [id, revokedBy],
    );
    return result.rows[0] === undefined ? null : toToken(result.rows[0]);
  }

  async findById(q: Queryable, id: string): Promise<AgentTokenRecord | null> {
    const result = await q.query<AgentTokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM security.agent_tokens WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : toToken(result.rows[0]);
  }
}

// --- device codes ----------------------------------------------------------

export type DeviceCodeState = 'pending' | 'approved' | 'consumed' | 'denied' | 'expired';

export interface DeviceCodeRecord {
  id: string;
  userCode: string;
  client: string;
  requestedScopes: AgentScope[];
  workspaceLabel: string | null;
  state: DeviceCodeState;
  projectId: string | null;
  agentTokenId: string | null;
  issuedToken: string | null;
  expiresAt: Date;
}

interface DeviceCodeRow {
  id: string;
  user_code: string;
  client: string;
  requested_scopes: string[];
  workspace_label: string | null;
  state: string;
  project_id: string | null;
  agent_token_id: string | null;
  issued_token: string | null;
  expires_at: Date;
}

const DEVICE_COLUMNS = `id, user_code, client, requested_scopes, workspace_label, state,
                        project_id, agent_token_id, issued_token, expires_at`;

function toDeviceCode(row: DeviceCodeRow): DeviceCodeRecord {
  return {
    id: row.id,
    userCode: row.user_code,
    client: row.client,
    requestedScopes: row.requested_scopes as AgentScope[],
    workspaceLabel: row.workspace_label,
    state: row.state as DeviceCodeState,
    projectId: row.project_id,
    agentTokenId: row.agent_token_id,
    issuedToken: row.issued_token,
    expiresAt: row.expires_at,
  };
}

export class DeviceCodeRepository {
  async create(
    q: Queryable,
    input: {
      deviceCodeHash: string;
      userCode: string;
      client: string;
      requestedScopes: readonly AgentScope[];
      workspaceLabel: string | null;
      expiresAt: Date;
    },
  ): Promise<DeviceCodeRecord> {
    const result = await q.query<DeviceCodeRow>(
      `INSERT INTO security.device_codes
         (device_code_hash, user_code, client, requested_scopes, workspace_label, expires_at)
       VALUES ($1, $2, $3, $4::text[], $5, $6) RETURNING ${DEVICE_COLUMNS}`,
      [
        input.deviceCodeHash,
        input.userCode,
        input.client,
        [...input.requestedScopes],
        input.workspaceLabel,
        input.expiresAt,
      ],
    );
    return toDeviceCode(result.rows[0]!);
  }

  async findByUserCode(q: Queryable, userCode: string): Promise<DeviceCodeRecord | null> {
    const result = await q.query<DeviceCodeRow>(
      `SELECT ${DEVICE_COLUMNS} FROM security.device_codes WHERE user_code = $1`,
      [userCode],
    );
    return result.rows[0] === undefined ? null : toDeviceCode(result.rows[0]);
  }

  async lockByUserCode(q: Queryable, userCode: string): Promise<DeviceCodeRecord | null> {
    const result = await q.query<DeviceCodeRow>(
      `SELECT ${DEVICE_COLUMNS} FROM security.device_codes WHERE user_code = $1 FOR UPDATE`,
      [userCode],
    );
    return result.rows[0] === undefined ? null : toDeviceCode(result.rows[0]);
  }

  async approve(
    q: Queryable,
    id: string,
    input: { projectId: string; approvedBy: string; agentTokenId: string; rawToken: string },
  ): Promise<void> {
    await q.query(
      `UPDATE security.device_codes
          SET state = 'approved', project_id = $2, approved_by = $3, agent_token_id = $4,
              issued_token = $5, approved_at = now()
        WHERE id = $1`,
      [id, input.projectId, input.approvedBy, input.agentTokenId, input.rawToken],
    );
  }

  /**
   * Hand the raw token to the polling CLI exactly once and erase it in the same statement, so
   * a second poll (or a database dump) can never yield the secret again.
   */
  async consume(q: Queryable, deviceCodeHash: string): Promise<DeviceCodeRecord | null> {
    // PostgreSQL 15 has no `OLD.` in RETURNING, so the pre-update secret is captured by a
    // locking CTE and joined back after the row has been cleared.
    const result = await q.query<DeviceCodeRow>(
      `WITH target AS (
         SELECT id, issued_token FROM security.device_codes
          WHERE device_code_hash = $1 AND state = 'approved' AND expires_at > now()
          FOR UPDATE
       ), updated AS (
         UPDATE security.device_codes d
            SET state = 'consumed', consumed_at = now(), issued_token = NULL
           FROM target
          WHERE d.id = target.id
        RETURNING d.id, d.user_code, d.client, d.requested_scopes, d.workspace_label,
                  d.state, d.project_id, d.agent_token_id, d.expires_at
       )
       SELECT updated.*, target.issued_token
         FROM updated JOIN target ON target.id = updated.id`,
      [deviceCodeHash],
    );
    return result.rows[0] === undefined ? null : toDeviceCode(result.rows[0]);
  }

  async statusByHash(q: Queryable, deviceCodeHash: string): Promise<DeviceCodeRecord | null> {
    const result = await q.query<DeviceCodeRow>(
      `UPDATE security.device_codes SET poll_count = poll_count + 1
        WHERE device_code_hash = $1 RETURNING ${DEVICE_COLUMNS}`,
      [deviceCodeHash],
    );
    return result.rows[0] === undefined ? null : toDeviceCode(result.rows[0]);
  }

  async listPending(q: Queryable, limit: number): Promise<DeviceCodeRecord[]> {
    const result = await q.query<DeviceCodeRow>(
      `SELECT ${DEVICE_COLUMNS} FROM security.device_codes
        WHERE state = 'pending' AND expires_at > now()
        ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(toDeviceCode);
  }

  async expireStale(q: Queryable): Promise<number> {
    const result = await q.query(
      `UPDATE security.device_codes SET state = 'expired', issued_token = NULL
        WHERE state IN ('pending', 'approved') AND expires_at <= now()`,
    );
    return result.rowCount ?? 0;
  }

  async deleteBefore(q: Queryable, before: Date): Promise<number> {
    const result = await q.query(`DELETE FROM security.device_codes WHERE expires_at < $1`, [
      before,
    ]);
    return result.rowCount ?? 0;
  }
}
