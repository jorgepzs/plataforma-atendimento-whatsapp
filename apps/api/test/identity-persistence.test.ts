import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  LocalIdentitySnapshot,
  LocalIdentityRepository,
  LocalSessionManager,
  localDemoPassword,
  localSessionCookieName
} from "../src/auth/local-sessions.js";

const sessionLifetimeMs = 8 * 60 * 60 * 1_000;

class MemoryIdentityRepository implements LocalIdentityRepository {
  private state: LocalIdentitySnapshot | undefined;
  failNextSave = false;

  load(): LocalIdentitySnapshot | undefined {
    return this.state === undefined ? undefined : structuredClone(this.state);
  }

  save(snapshot: LocalIdentitySnapshot): void {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("simulated persistence failure");
    }
    this.state = structuredClone(snapshot);
  }

  restoreAfterExternalRollback(snapshot: LocalIdentitySnapshot): void {
    this.state = structuredClone(snapshot);
  }
}

function request(token: string): FastifyRequest {
  return { headers: { cookie: `${localSessionCookieName}=${token}` } } as FastifyRequest;
}

describe("local identity persistence", () => {
  it("restores a session cookie and memberships after manager recreation", async () => {
    const repository = new MemoryIdentityRepository();
    const first = new LocalSessionManager(() => 1_000, repository);
    const login = await first.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    first.addMembership(login.session.user.id, "new-local-tenant", "TENANT_ADMIN");
    first.close();

    const restored = new LocalSessionManager(() => 1_001, repository);
    const session = restored.requireSession(request(login.token));
    expect(session.user.id).toBe("admin-demo");
    expect(session.user.memberships).toContainEqual({ tenantId: "new-local-tenant", role: "TENANT_ADMIN" });
    expect(repository.load()?.sessions[0]?.tokenHash).not.toBe(login.token);
  });

  it("persists logout revocation across manager recreation", async () => {
    const repository = new MemoryIdentityRepository();
    const first = new LocalSessionManager(undefined, repository);
    const login = await first.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    first.invalidate(request(login.token));
    first.close();

    const restored = new LocalSessionManager(undefined, repository);
    expect(() => restored.requireSession(request(login.token))).toThrow("Entre na sua conta");
    expect(repository.load()?.sessions).toEqual([]);
  });

  it("rotates cookies atomically and restores only the new cookie after restart", async () => {
    const repository = new MemoryIdentityRepository();
    const first = new LocalSessionManager(undefined, repository);
    const oldLogin = await first.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    first.close();

    const second = new LocalSessionManager(undefined, repository);
    const rotated = await second.login("admin@atende.local", localDemoPassword, "127.0.0.1", request(oldLogin.token));
    second.close();

    const restored = new LocalSessionManager(undefined, repository);
    expect(() => restored.requireSession(request(oldLogin.token))).toThrow("Entre na sua conta");
    expect(restored.requireSession(request(rotated.token)).user.id).toBe("admin-demo");
    expect(repository.load()?.sessions).toHaveLength(1);
  });

  it("reloads users and sessions from the database snapshot after an external rollback", async () => {
    const repository = new MemoryIdentityRepository();
    const sessions = new LocalSessionManager(undefined, repository);
    const oldLogin = await sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    const beforeTransaction = repository.load();
    expect(beforeTransaction).toBeDefined();

    const rotated = await sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1", request(oldLogin.token));
    sessions.addMembership("admin-demo", "rolled-back-tenant", "TENANT_ADMIN");
    expect(sessions.requireSession(request(rotated.token)).user.memberships)
      .toContainEqual({ tenantId: "rolled-back-tenant", role: "TENANT_ADMIN" });

    repository.restoreAfterExternalRollback(beforeTransaction!);
    sessions.reloadFromRepository();

    const reloaded = sessions.requireSession(request(oldLogin.token));
    expect(reloaded.user.memberships).not.toContainEqual({ tenantId: "rolled-back-tenant", role: "TENANT_ADMIN" });
    expect(() => sessions.requireSession(request(rotated.token))).toThrow("Entre na sua conta");
  });

  it("preserves the previous cookie and creates no new session if rotation save fails", async () => {
    const repository = new MemoryIdentityRepository();
    const sessions = new LocalSessionManager(undefined, repository);
    const oldLogin = await sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1");

    repository.failNextSave = true;
    await expect(sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1", request(oldLogin.token)))
      .rejects.toThrow("simulated persistence failure");

    expect(sessions.requireSession(request(oldLogin.token)).user.id).toBe("admin-demo");
    expect(repository.load()?.sessions).toHaveLength(1);
    const restored = new LocalSessionManager(undefined, repository);
    expect(restored.requireSession(request(oldLogin.token)).user.id).toBe("admin-demo");
  });

  it("persists pruning when a session expires", async () => {
    let now = 20_000;
    const repository = new MemoryIdentityRepository();
    const sessions = new LocalSessionManager(() => now, repository);
    const login = await sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    now += sessionLifetimeMs;

    expect(() => sessions.requireSession(request(login.token))).toThrow("Entre na sua conta");
    expect(repository.load()?.sessions).toEqual([]);
    sessions.close();
    const restored = new LocalSessionManager(() => now, repository);
    expect(() => restored.requireSession(request(login.token))).toThrow("Entre na sua conta");
  });

  it("rolls back a failed login, membership update, and logout save", async () => {
    const repository = new MemoryIdentityRepository();
    const sessions = new LocalSessionManager(undefined, repository);
    const seedSnapshot = repository.load();
    expect(seedSnapshot).toBeDefined();

    repository.failNextSave = true;
    await expect(sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1"))
      .rejects.toThrow("simulated persistence failure");
    expect(repository.load()?.sessions).toEqual([]);

    const login = await sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    repository.failNextSave = true;
    expect(() => sessions.addMembership(login.session.user.id, "failed-tenant", "TENANT_ADMIN"))
      .toThrow("simulated persistence failure");
    expect(sessions.requireSession(request(login.token)).user.memberships)
      .not.toContainEqual({ tenantId: "failed-tenant", role: "TENANT_ADMIN" });
    expect(repository.load()?.users.find((user) => user.id === login.session.user.id)?.memberships)
      .not.toContainEqual({ tenantId: "failed-tenant", role: "TENANT_ADMIN" });

    repository.failNextSave = true;
    expect(() => sessions.invalidate(request(login.token))).toThrow("simulated persistence failure");
    expect(sessions.requireSession(request(login.token)).user.id).toBe("admin-demo");
    expect(new LocalSessionManager(undefined, repository).requireSession(request(login.token)).user.id).toBe("admin-demo");
  });

  it("keeps mutations made while password scrypt is in flight", async () => {
    const repository = new MemoryIdentityRepository();
    const sessions = new LocalSessionManager(undefined, repository);
    const loginPromise = sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    sessions.addMembership("admin-demo", "concurrent-tenant", "TENANT_ADMIN");
    const login = await loginPromise;

    const restored = new LocalSessionManager(undefined, repository);
    const session = restored.requireSession(request(login.token));
    expect(session.user.memberships).toContainEqual({ tenantId: "concurrent-tenant", role: "TENANT_ADMIN" });
  });
});
