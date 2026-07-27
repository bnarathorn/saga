import type { AgentScope, UserRole } from '@saga/contracts';
import type { SagaPool } from '@saga/database';
import { withTransaction } from '@saga/database';
import { SagaError, addMinutes, addSeconds } from '@saga/shared';
import type { Actor, AgentActor, UserActor } from '../security/authorization.js';
import {
  generateAgentToken,
  generateCsrfToken,
  generateDeviceCode,
  generateSessionId,
  hashPassword,
  hashSecret,
  normalizeUserCode,
  verifyPassword,
} from '../security/credentials.js';
import {
  type AgentTokenRepository,
  type DeviceCodeRepository,
  type UserRepository,
  type WebSessionRepository,
  type AgentTokenRecord,
  type DeviceCodeRecord,
  type UserRecord,
} from '../repositories/security-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const DEVICE_CODE_TTL_SECONDS = 600;
const DEVICE_POLL_INTERVAL_SECONDS = 3;

export const DEFAULT_AGENT_SCOPES: AgentScope[] = [
  'project:read',
  'lore:read',
  'lore:propose',
  'lore:publish',
  'quest:read',
  'quest:write',
  'party:heartbeat',
  'party:claim',
];

export interface AuthServiceDeps {
  pool: SagaPool;
  users: UserRepository;
  sessions: WebSessionRepository;
  agentTokens: AgentTokenRepository;
  deviceCodes: DeviceCodeRepository;
  projects: ProjectRepository;
  sessionTtlHours: number;
  publicUrl: string;
}

export interface LoginResult {
  user: UserRecord;
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  // --- users ---------------------------------------------------------------

  async createUser(input: {
    email: string;
    displayName: string;
    password: string;
    role: UserRole;
  }): Promise<UserRecord> {
    const passwordHash = await hashPassword(input.password);
    return this.deps.users.create(this.deps.pool, {
      email: input.email,
      displayName: input.displayName,
      passwordHash,
      role: input.role,
    });
  }

  /** Create the first administrator if — and only if — no user exists yet. */
  async bootstrapAdmin(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<UserRecord | null> {
    return withTransaction(this.deps.pool, async (tx) => {
      const existing = await this.deps.users.count(tx);
      if (existing > 0) return null;
      const passwordHash = await hashPassword(input.password);
      return this.deps.users.create(tx, {
        email: input.email,
        displayName: input.displayName ?? 'Administrator',
        passwordHash,
        role: 'admin',
      });
    });
  }

  async userCount(): Promise<number> {
    return this.deps.users.count(this.deps.pool);
  }

  // --- web sessions --------------------------------------------------------

  /**
   * Verify credentials and mint a fresh session. The same generic message is returned for an
   * unknown address and a wrong password so the endpoint cannot enumerate accounts.
   */
  async login(input: {
    email: string;
    password: string;
    userAgent?: string | null;
    ipAddress?: string | null;
    now?: Date;
  }): Promise<LoginResult> {
    const now = input.now ?? new Date();
    const user = await this.deps.users.findByEmail(this.deps.pool, input.email);

    if (user === null) {
      // Spend comparable time on an unknown address so timing does not reveal existence.
      await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA', input.password);
      throw new SagaError('INVALID_CREDENTIALS', 'The email address or password is incorrect.');
    }

    if (user.lockedUntil !== null && user.lockedUntil > now) {
      throw new SagaError(
        'ACCOUNT_LOCKED',
        'Too many failed attempts. Try again after the lockout expires.',
        { details: { locked_until: user.lockedUntil.toISOString() } },
      );
    }

    if (user.state !== 'active') {
      throw new SagaError('INVALID_CREDENTIALS', 'The email address or password is incorrect.');
    }

    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) {
      const attempts = user.failedAttempts + 1;
      const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? addMinutes(now, LOCKOUT_MINUTES) : null;
      await this.deps.users.recordFailedLogin(this.deps.pool, user.id, lockedUntil);
      throw new SagaError('INVALID_CREDENTIALS', 'The email address or password is incorrect.');
    }

    const sessionId = generateSessionId();
    const csrfToken = generateCsrfToken();
    const expiresAt = addSeconds(now, this.deps.sessionTtlHours * 3_600);

    await withTransaction(this.deps.pool, async (tx) => {
      await this.deps.users.recordSuccessfulLogin(tx, user.id);
      await this.deps.sessions.create(tx, {
        userId: user.id,
        sessionHash: hashSecret(sessionId),
        csrfTokenHash: hashSecret(csrfToken),
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
        expiresAt,
      });
    });

    return { user, sessionId, csrfToken, expiresAt };
  }

  async logout(sessionId: string): Promise<void> {
    await this.deps.sessions.revoke(this.deps.pool, hashSecret(sessionId));
  }

  async resolveSession(
    sessionId: string,
  ): Promise<{ actor: UserActor; csrfTokenHash: string } | null> {
    const record = await this.deps.sessions.touch(this.deps.pool, hashSecret(sessionId));
    if (record === null) return null;
    return {
      actor: {
        type: 'user',
        userId: record.user.id,
        email: record.user.email,
        displayName: record.user.displayName,
        role: record.user.role,
        sessionId: record.id,
      },
      csrfTokenHash: record.csrfTokenHash,
    };
  }

  // --- agent tokens --------------------------------------------------------

  async resolveAgentToken(rawToken: string): Promise<AgentActor | null> {
    const record = await this.deps.agentTokens.authenticate(this.deps.pool, hashSecret(rawToken));
    if (record === null) return null;
    return {
      type: 'agent',
      tokenId: record.id,
      projectId: record.projectId,
      name: record.name,
      scopes: record.scopes,
    };
  }

  async createAgentToken(input: {
    projectId: string;
    projectNameKey: string;
    createdBy: string | null;
    name: string;
    scopes: readonly AgentScope[];
    client?: string | null;
    expiresInDays?: number;
    now?: Date;
  }): Promise<{ record: AgentTokenRecord; rawToken: string }> {
    const now = input.now ?? new Date();
    const token = generateAgentToken(input.projectNameKey);
    const record = await this.deps.agentTokens.create(this.deps.pool, {
      projectId: input.projectId,
      createdBy: input.createdBy,
      name: input.name,
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      scopes: input.scopes,
      client: input.client ?? null,
      expiresAt:
        input.expiresInDays === undefined ? null : addSeconds(now, input.expiresInDays * 86_400),
    });
    return { record, rawToken: token.raw };
  }

  async listAgentTokens(projectId: string): Promise<AgentTokenRecord[]> {
    return this.deps.agentTokens.listForProject(this.deps.pool, projectId);
  }

  async revokeAgentToken(id: string, revokedBy: string | null): Promise<AgentTokenRecord> {
    const record = await this.deps.agentTokens.revoke(this.deps.pool, id, revokedBy);
    if (record === null) {
      throw new SagaError('NOT_FOUND', 'No active agent token matches that id.');
    }
    return record;
  }

  // --- device flow ---------------------------------------------------------

  async startDeviceFlow(input: {
    client: string;
    workspaceLabel?: string | null;
    scopes?: readonly AgentScope[];
    now?: Date;
  }): Promise<{ deviceCode: string; record: DeviceCodeRecord; intervalSeconds: number; verificationUri: string }> {
    const now = input.now ?? new Date();
    const { deviceCode, deviceCodeHash, userCode } = generateDeviceCode();
    const record = await this.deps.deviceCodes.create(this.deps.pool, {
      deviceCodeHash,
      userCode,
      client: input.client,
      requestedScopes: input.scopes ?? DEFAULT_AGENT_SCOPES,
      workspaceLabel: input.workspaceLabel ?? null,
      expiresAt: addSeconds(now, DEVICE_CODE_TTL_SECONDS),
    });
    return {
      deviceCode,
      record,
      intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
      verificationUri: `${this.deps.publicUrl.replace(/\/$/, '')}/device`,
    };
  }

  /**
   * Approve a pending device code and mint the project-scoped token in one transaction, so a
   * crash can never leave an approved code without its token or vice versa.
   */
  async approveDeviceFlow(input: {
    userCode: string;
    projectId: string;
    projectNameKey: string;
    approvedBy: string;
    tokenName: string;
    scopes?: readonly AgentScope[];
    expiresInDays?: number;
    now?: Date;
  }): Promise<AgentTokenRecord> {
    const now = input.now ?? new Date();
    const userCode = normalizeUserCode(input.userCode);

    return withTransaction(this.deps.pool, async (tx) => {
      const record = await this.deps.deviceCodes.lockByUserCode(tx, userCode);
      if (record === null) {
        throw new SagaError('DEVICE_CODE_INVALID', 'That approval code was not recognised.');
      }
      if (record.expiresAt <= now) {
        throw new SagaError('DEVICE_CODE_EXPIRED', 'That approval code has expired. Run `saga connect` again.');
      }
      if (record.state !== 'pending') {
        throw new SagaError(
          'DEVICE_CODE_INVALID',
          `That approval code is already ${record.state}.`,
          { details: { state: record.state } },
        );
      }

      const scopes = input.scopes ?? record.requestedScopes;
      const token = generateAgentToken(input.projectNameKey);
      const created = await this.deps.agentTokens.create(tx, {
        projectId: input.projectId,
        createdBy: input.approvedBy,
        name: input.tokenName,
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        scopes,
        client: record.client,
        expiresAt:
          input.expiresInDays === undefined ? null : addSeconds(now, input.expiresInDays * 86_400),
      });

      await this.deps.deviceCodes.approve(tx, record.id, {
        projectId: input.projectId,
        approvedBy: input.approvedBy,
        agentTokenId: created.id,
        rawToken: token.raw,
      });

      return created;
    });
  }

  async pollDeviceFlow(deviceCode: string): Promise<{
    state: DeviceCodeRecord['state'];
    token: string | null;
    projectId: string | null;
    scopes: AgentScope[] | null;
    expiresAt: Date | null;
  }> {
    const hash = hashSecret(deviceCode);

    // Try to consume first: an approved code hands over its secret exactly once.
    const consumed = await this.deps.deviceCodes.consume(this.deps.pool, hash);
    if (consumed !== null) {
      return {
        state: 'approved',
        token: consumed.issuedToken,
        projectId: consumed.projectId,
        scopes: consumed.requestedScopes,
        expiresAt: consumed.expiresAt,
      };
    }

    const status = await this.deps.deviceCodes.statusByHash(this.deps.pool, hash);
    if (status === null) {
      throw new SagaError('DEVICE_CODE_INVALID', 'That device code was not recognised.');
    }
    if (status.expiresAt <= new Date() && status.state !== 'consumed') {
      return { state: 'expired', token: null, projectId: null, scopes: null, expiresAt: status.expiresAt };
    }
    return {
      state: status.state,
      token: null,
      projectId: status.projectId,
      scopes: status.requestedScopes,
      expiresAt: status.expiresAt,
    };
  }

  async listPendingDeviceCodes(limit = 20): Promise<DeviceCodeRecord[]> {
    return this.deps.deviceCodes.listPending(this.deps.pool, limit);
  }
}

export function isAuthenticated(actor: Actor): actor is UserActor | AgentActor {
  return actor.type !== 'anonymous';
}
