import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { LocalSessionManager, localDemoPassword, localSessionCookieName } from "../src/auth/local-sessions.js";

function request(token: string, headers: Record<string, string> = {}): FastifyRequest {
  return { headers: { cookie: `${localSessionCookieName}=${token}`, ...headers } } as FastifyRequest;
}

describe("local session lifecycle", () => {
  it("expires cookies and invalidates logged-out sessions on the server", async () => {
    let now = Date.now();
    const sessions = new LocalSessionManager(() => now);
    const first = await sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    const authenticated = request(first.token);
    expect(sessions.requireSession(authenticated).user.id).toBe("admin-demo");
    now += 8 * 60 * 60 * 1_000;
    expect(() => sessions.requireSession(authenticated)).toThrow("Entre na sua conta");
    const second = await sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    sessions.invalidate(request(second.token));
    expect(() => sessions.requireSession(request(second.token))).toThrow("Entre na sua conta");
    sessions.close();
  });

  it("rejects cross-origin writes even with the correct CSRF token", async () => {
    const sessions = new LocalSessionManager();
    const login = await sessions.login("admin@atende.local", localDemoPassword, "127.0.0.1");
    expect(() => sessions.requireCsrf(request(login.token, {
      "x-csrf-token": login.session.csrfToken, origin: "https://untrusted.example"
    }), login.session)).toThrow("Origem");
    expect(() => sessions.requireCsrf(request(login.token, {
      "x-csrf-token": login.session.csrfToken, origin: "http://127.0.0.1:5173"
    }), login.session)).not.toThrow();
  });

  it("limits credential guessing without revealing which email exists", async () => {
    const sessions = new LocalSessionManager();
    await expect(sessions.login("unknown@atende.local", "wrong", "guessing-ip")).rejects.toMatchObject({ statusCode: 401, code: "invalid_credentials" });
    for (let attempt = 1; attempt < 10; attempt += 1) {
      await expect(sessions.login("admin@atende.local", "wrong", "guessing-ip")).rejects.toMatchObject({ statusCode: 401, code: "invalid_credentials" });
    }
    await expect(sessions.login("admin@atende.local", localDemoPassword, "guessing-ip")).rejects.toMatchObject({ statusCode: 429 });
  });
});
