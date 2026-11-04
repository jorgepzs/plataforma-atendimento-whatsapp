import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";

const deriveKey = promisify(scrypt);
const sessionLifetimeMs = 8 * 60 * 60 * 1_000;
export const localSessionCookieName = "atende_session";
export const localDemoPassword = "AtendeLocal123!";

export type LocalRole = "TENANT_ADMIN" | "ATTENDANT";
export interface LocalMembership { tenantId: string; role: LocalRole }
export interface LocalUser {
  id: string;
  email: string;
  displayName: string;
  platformAdmin: boolean;
  memberships: LocalMembership[];
}
export interface LocalSession { user: LocalUser; csrfToken: string; expiresAt: string }
interface StoredUser extends LocalUser { salt: Buffer; passwordHash: Buffer }
interface StoredSession { userId: string; csrfToken: string; expiresAtMs: number }

export interface LocalIdentitySnapshot {
  users: Array<{
    id: string;
    email: string;
    displayName: string;
    platformAdmin: boolean;
    memberships: LocalMembership[];
    saltHex: string;
    passwordHashHex: string;
  }>;
  sessions: Array<{ tokenHash: string; userId: string; csrfToken: string; expiresAtMs: number }>;
}

export interface LocalIdentityRepository {
  load(): LocalIdentitySnapshot | undefined;
  save(snapshot: LocalIdentitySnapshot): void;
}

export class LocalHttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = "LocalHttpError";
  }
}

const allowedOrigins = new Set([
  "http://127.0.0.1:5173", "http://localhost:5173",
  "http://127.0.0.1:3000", "http://localhost:3000"
]);

export function requireLocalOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    throw new LocalHttpError(403, "invalid_origin", "Origem da requisição não permitida.");
  }
}

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class LocalSessionManager {
  private readonly users = new Map<string, StoredUser>();
  private readonly sessions = new Map<string, StoredSession>();
  // Login rate limits are intentionally process-local and reset when this local service restarts.
  private readonly loginAttempts = new Map<string, { count: number; expiresAtMs: number }>();
  private readonly dummySalt = randomBytes(16);
  private readonly dummyHash = scryptSync(randomBytes(32), this.dummySalt, 64);
  private readonly repository: LocalIdentityRepository | undefined;

  constructor(private readonly now: () => number = Date.now, repository?: LocalIdentityRepository) {
    this.repository = repository;
    const snapshot = repository?.load();
    if (snapshot) {
      this.restore(snapshot);
      if (this.sessions.size !== snapshot.sessions.length) this.saveCurrentState();
      return;
    }

    // The demo identities are initialized once, only for a genuinely new repository.
    const demoUsers: LocalUser[] = [
      { id: "admin-demo", email: "admin@atende.local", displayName: "Administrador local", platformAdmin: true,
        memberships: [{ tenantId: "pizzaria-demo", role: "TENANT_ADMIN" }, { tenantId: "barbearia-demo", role: "TENANT_ADMIN" }] },
      { id: "pizzaria-user", email: "pizzaria@atende.local", displayName: "Atendente da pizzaria", platformAdmin: false,
        memberships: [{ tenantId: "pizzaria-demo", role: "ATTENDANT" }] },
      { id: "barbearia-user", email: "barbearia@atende.local", displayName: "Atendente da barbearia", platformAdmin: false,
        memberships: [{ tenantId: "barbearia-demo", role: "ATTENDANT" }] }
    ];
    for (const user of demoUsers) {
      const salt = randomBytes(16);
      this.users.set(user.id, { ...user, salt, passwordHash: scryptSync(localDemoPassword, salt, 64) });
    }
    this.saveCurrentState();
  }

  private restore(
    snapshot: LocalIdentitySnapshot,
    users: Map<string, StoredUser> = this.users,
    sessions: Map<string, StoredSession> = this.sessions
  ): void {
    for (const user of snapshot.users) {
      if (!/^[\da-f]{32}$/i.test(user.saltHex) || !/^[\da-f]{128}$/i.test(user.passwordHashHex)) {
        throw new Error("Snapshot local de identidade inválido.");
      }
      if (users.has(user.id)) throw new Error("Snapshot local de identidade contém usuários duplicados.");
      users.set(user.id, {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        platformAdmin: user.platformAdmin,
        memberships: user.memberships.map((membership) => ({ ...membership })),
        salt: Buffer.from(user.saltHex, "hex"),
        passwordHash: Buffer.from(user.passwordHashHex, "hex")
      });
    }

    const now = this.now();
    for (const session of snapshot.sessions) {
      if (!/^[\da-f]{64}$/i.test(session.tokenHash) || !Number.isFinite(session.expiresAtMs)) {
        throw new Error("Snapshot local de identidade inválido.");
      }
      if (session.expiresAtMs <= now || !users.has(session.userId)) continue;
      if (sessions.has(session.tokenHash)) throw new Error("Snapshot local de identidade contém sessões duplicadas.");
      sessions.set(session.tokenHash, {
        userId: session.userId,
        csrfToken: session.csrfToken,
        expiresAtMs: session.expiresAtMs
      });
    }
  }

  private snapshot(): LocalIdentitySnapshot {
    return {
      users: [...this.users.values()].map((user) => ({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        platformAdmin: user.platformAdmin,
        memberships: user.memberships.map((membership) => ({ ...membership })),
        saltHex: user.salt.toString("hex"),
        passwordHashHex: user.passwordHash.toString("hex")
      })),
      // The opaque browser cookie is never stored; only its SHA-256 digest is durable.
      sessions: [...this.sessions.entries()].map(([tokenHash, session]) => ({
        tokenHash,
        userId: session.userId,
        csrfToken: session.csrfToken,
        expiresAtMs: session.expiresAtMs
      }))
    };
  }

  private saveCurrentState(): void { this.repository?.save(this.snapshot()); }

  private commit(apply: () => void, rollback: () => void): void {
    apply();
    try {
      this.saveCurrentState();
    } catch (error) {
      rollback();
      throw error;
    }
  }

  private publicUser(user: StoredUser): LocalUser {
    return { id: user.id, email: user.email, displayName: user.displayName, platformAdmin: user.platformAdmin,
      memberships: user.memberships.map((membership) => ({ ...membership })) };
  }

  private readToken(request: FastifyRequest): string | undefined {
    const matches = (request.headers.cookie ?? "").split(";").map((entry) => entry.trim())
      .filter((entry) => entry.startsWith(`${localSessionCookieName}=`));
    if (matches.length !== 1) return undefined;
    const token = matches[0]?.slice(localSessionCookieName.length + 1);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, attempt] of this.loginAttempts) if (attempt.expiresAtMs <= now) this.loginAttempts.delete(key);

    const expired = [...this.sessions.entries()].filter(([, session]) => session.expiresAtMs <= now);
    if (expired.length === 0) return;
    this.commit(
      () => { for (const [key] of expired) this.sessions.delete(key); },
      () => { for (const [key, session] of expired) this.sessions.set(key, session); }
    );
  }

  async login(email: string, password: string, ip: string, previousRequest?: FastifyRequest): Promise<{ token: string; session: LocalSession }> {
    this.prune();
    const now = this.now();
    const attempt = this.loginAttempts.get(ip) ?? { count: 0, expiresAtMs: now + 5 * 60 * 1_000 };
    if (attempt.count >= 10 || (!this.loginAttempts.has(ip) && this.loginAttempts.size >= 1_024)) {
      throw new LocalHttpError(429, "login_rate_limited", "Muitas tentativas. Aguarde alguns minutos e tente novamente.");
    }
    attempt.count += 1;
    this.loginAttempts.set(ip, attempt);
    const candidate = [...this.users.values()].find((entry) => entry.email === email.trim().toLowerCase());
    const passwordHash = (await deriveKey(password, candidate?.salt ?? this.dummySalt, 64)) as Buffer;
    // Re-read live state after scrypt yields: another synchronous mutation may have run meanwhile.
    const user = candidate ? this.users.get(candidate.id) : undefined;
    const matches = timingSafeEqual(passwordHash, user?.passwordHash ?? this.dummyHash);
    if (!user || !matches) throw new LocalHttpError(401, "invalid_credentials", "E-mail ou senha incorretos.");
    this.loginAttempts.delete(ip);
    const previousToken = previousRequest ? this.readToken(previousRequest) : undefined;
    const previousKey = previousToken ? hashToken(previousToken) : undefined;
    const previousSession = previousKey ? this.sessions.get(previousKey) : undefined;
    if (this.sessions.size - (previousSession ? 1 : 0) >= 1_000) {
      throw new LocalHttpError(503, "session_limit", "Limite de sessões do ambiente local atingido.");
    }
    let token = randomBytes(32).toString("base64url");
    let key = hashToken(token);
    while (this.sessions.has(key)) {
      token = randomBytes(32).toString("base64url");
      key = hashToken(token);
    }
    const storedSession = { userId: user.id, csrfToken: randomBytes(32).toString("base64url"), expiresAtMs: this.now() + sessionLifetimeMs };
    this.commit(
      () => {
        this.sessions.set(key, storedSession);
        if (previousKey && previousSession) this.sessions.delete(previousKey);
      },
      () => {
        this.sessions.delete(key);
        if (previousKey && previousSession) this.sessions.set(previousKey, previousSession);
      }
    );
    return { token, session: { user: this.publicUser(user), csrfToken: storedSession.csrfToken, expiresAt: new Date(storedSession.expiresAtMs).toISOString() } };
  }

  requireSession(request: FastifyRequest): LocalSession {
    const token = this.readToken(request);
    const key = token ? hashToken(token) : undefined;
    const session = key ? this.sessions.get(key) : undefined;
    if (!session || session.expiresAtMs <= this.now()) {
      if (key && session) {
        this.commit(
          () => { this.sessions.delete(key); },
          () => { this.sessions.set(key, session); }
        );
      }
      throw new LocalHttpError(401, "unauthenticated", "Entre na sua conta para continuar.");
    }
    const user = this.users.get(session.userId);
    if (!user) throw new LocalHttpError(401, "unauthenticated", "Sessão inválida.");
    return { user: this.publicUser(user), csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAtMs).toISOString() };
  }

  requireCsrf(request: FastifyRequest, session: LocalSession): void {
    requireLocalOrigin(request);
    const provided = request.headers["x-csrf-token"];
    if (typeof provided !== "string" || provided.length > 128 || !secureEquals(provided, session.csrfToken)) {
      throw new LocalHttpError(403, "invalid_csrf", "Recarregue a sessão antes de realizar esta ação.");
    }
  }

  requireTenant(session: LocalSession, tenantId: string): LocalMembership {
    const membership = session.user.memberships.find((candidate) => candidate.tenantId === tenantId);
    if (!membership) throw new LocalHttpError(403, "tenant_forbidden", "Você não possui acesso a este cliente.");
    return membership;
  }

  requireAdmin(session: LocalSession, tenantId: string): LocalMembership {
    const membership = this.requireTenant(session, tenantId);
    if (membership.role !== "TENANT_ADMIN") throw new LocalHttpError(403, "admin_required", "Apenas administradores podem alterar esta configuração.");
    return membership;
  }

  addMembership(userId: string, tenantId: string, role: LocalRole): void {
    const user = this.users.get(userId);
    if (!user) throw new LocalHttpError(404, "user_not_found", "Usuário não encontrado.");
    if (!user.memberships.some((entry) => entry.tenantId === tenantId)) {
      const membership = { tenantId, role };
      this.commit(
        () => { user.memberships.push(membership); },
        () => { user.memberships.pop(); }
      );
    }
  }

  invalidate(request: FastifyRequest): void {
    const token = this.readToken(request);
    if (!token) return;
    const key = hashToken(token);
    const session = this.sessions.get(key);
    if (!session) return;
    this.commit(
      () => { this.sessions.delete(key); },
      () => { this.sessions.set(key, session); }
    );
  }

  close(): void { this.sessions.clear(); this.loginAttempts.clear(); }

  reloadFromRepository(): void {
    if (!this.repository) throw new Error("Não há repositório local de identidade configurado.");
    const snapshot = this.repository.load();
    if (!snapshot) throw new Error("Não há snapshot local de identidade para restaurar.");

    const users = new Map<string, StoredUser>();
    const sessions = new Map<string, StoredSession>();
    this.restore(snapshot, users, sessions);
    this.users.clear();
    this.sessions.clear();
    for (const [id, user] of users) this.users.set(id, user);
    for (const [tokenHash, session] of sessions) this.sessions.set(tokenHash, session);
  }
}
