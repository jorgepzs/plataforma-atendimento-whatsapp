import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LocalSessionManager, localSessionCookieName, requireLocalOrigin } from "./local-sessions.js";

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128)
}).strict();

export async function registerLocalAuthRoutes(app: FastifyInstance, sessions: LocalSessionManager): Promise<void> {
  app.post("/api/v1/auth/login", async (request, reply) => {
    requireLocalOrigin(request);
    const credentials = credentialsSchema.parse(request.body);
    const result = await sessions.login(credentials.email, credentials.password, request.ip, request);
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", `${localSessionCookieName}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    return result.session;
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return sessions.requireSession(request);
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const session = sessions.requireSession(request);
    sessions.requireCsrf(request, session);
    sessions.invalidate(request);
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", `${localSessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return reply.status(204).send();
  });
}
