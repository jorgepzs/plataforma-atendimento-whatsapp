import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireLocalOrigin } from "../auth/local-sessions.js";
import { conversationStates } from "../domain/conversation-state.js";
import { AttendanceError, LocalAttendanceService } from "./service.js";
import type {
  CreateTenantInput,
  LocalSession,
  LocalSessionManager,
  UpdateTenantConfigInput
} from "./types.js";

const tenantIdSchema = z.string().min(1).max(128);
const tenantParamsSchema = z.strictObject({ tenantId: tenantIdSchema });
const conversationParamsSchema = z.strictObject({
  tenantId: tenantIdSchema,
  conversationId: z.string().min(1).max(128)
});

const segmentSchema = z.enum(["pizzaria", "barbearia", "outro"] as const);
const createTenantSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(120),
  segment: segmentSchema
});
const bindTestChannelSchema = z.strictObject({
  phoneNumberId: z.string().regex(/^[1-9][0-9]{0,31}$/)
});
const updateConfigSchema = z.strictObject({
  businessName: z.string().trim().min(1).max(120),
  segment: segmentSchema,
  greeting: z.string().trim().min(1).max(1000),
  knowledge: z.array(
    z.strictObject({
      question: z.string().trim().min(1).max(300),
      answer: z.string().trim().min(1).max(1000)
    })
  ).max(100),
  handoffKeywords: z.array(z.string().trim().min(1).max(80)).max(50),
  assistantMode: z.enum(["approved_faq", "local_ai"]).optional(),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
});
const simulateSchema = z.strictObject({
  customerName: z.string().trim().min(1).max(120),
  customerPhone: z.string().trim().min(3).max(32),
  text: z.string().trim().min(1).max(4000),
  clientMessageId: z.string().trim().min(1).max(200).optional()
});
const replySchema = z.strictObject({ text: z.string().trim().min(1).max(4000) });
const conversationQuerySchema = z.strictObject({ state: z.enum(conversationStates).optional() });
const noBodySchema = z.union([z.undefined(), z.strictObject({})]);

function body<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function noBody(value: unknown): void {
  noBodySchema.parse(value);
}

async function requireSession(request: FastifyRequest, sessions: LocalSessionManager): Promise<LocalSession> {
  return await sessions.requireSession(request);
}

async function requireWrite(
  request: FastifyRequest,
  sessions: LocalSessionManager
): Promise<LocalSession> {
  const session = await requireSession(request, sessions);
  await sessions.requireCsrf(request, session);
  return session;
}

export async function registerAttendanceRoutes(
  app: FastifyInstance,
  service: LocalAttendanceService,
  sessions: LocalSessionManager,
  createTenantWithMembership?: (input: CreateTenantInput, userId: string) => ReturnType<LocalAttendanceService["createTenant"]>
): Promise<void> {
  app.get("/api/v1/tenants", async (request, reply) => {
    const session = await requireSession(request, sessions);
    return reply.send({
      tenants: service.listTenants(session.user.memberships.map((membership) => membership.tenantId))
    });
  });

  app.post<{ Body: unknown }>("/api/v1/tenants", async (request, reply) => {
    const session = await requireWrite(request, sessions);
    if (!session.user.platformAdmin) {
      throw new AttendanceError(403, "platform_admin_required", "Somente administrador da plataforma pode criar empresas.");
    }
    const input = body<CreateTenantInput>(createTenantSchema, request.body);
    const tenant = createTenantWithMembership
      ? createTenantWithMembership(input, session.user.id)
      : service.createTenant(input);
    if (!createTenantWithMembership) sessions.addMembership(session.user.id, tenant.id, "TENANT_ADMIN");
    return reply.status(201).send({ tenant });
  });

  app.put<{ Params: unknown; Body: unknown }>("/api/v1/tenants/:tenantId/channel", async (request, reply) => {
    const { tenantId } = body(tenantParamsSchema, request.params);
    const session = await requireWrite(request, sessions);
    if (!session.user.platformAdmin) {
      throw new AttendanceError(403, "platform_admin_required", "Somente administrador da plataforma pode associar canais.");
    }
    const { phoneNumberId } = body(bindTestChannelSchema, request.body);
    return reply.send({ tenant: service.bindTestChannel(tenantId, phoneNumberId) });
  });

  app.get<{ Params: unknown }>("/api/v1/tenants/:tenantId/config", async (request, reply) => {
    const { tenantId } = body(tenantParamsSchema, request.params);
    const session = await requireSession(request, sessions);
    await sessions.requireTenant(session, tenantId);
    return reply.send(service.getConfig(tenantId));
  });

  app.get<{ Params: unknown }>("/api/v1/tenants/:tenantId/events", async (request, reply) => {
    const { tenantId } = body(tenantParamsSchema, request.params);
    requireLocalOrigin(request);
    const session = await requireSession(request, sessions);
    await sessions.requireTenant(session, tenantId);

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff"
    });
    response.flushHeaders();

    let closed = false;
    let checks = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = (): void => undefined;
    const close = (endResponse = false): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      if (endResponse && !response.destroyed && !response.writableEnded) response.end();
    };
    const sendEvent = (eventName: string, payload: Record<string, string>): void => {
      if (closed || response.destroyed || !response.writable) return;
      const accepted = response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
      if (!accepted) close(true);
    };

    response.once("close", () => close());
    response.once("error", () => close());
    unsubscribe = service.subscribeToTenantChanges(tenantId, () => {
      sendEvent("attendance.queue.changed.v1", {
        type: "attendance.queue.changed.v1",
        occurredAt: new Date().toISOString()
      });
    });
    heartbeat = setInterval(() => {
      checks += 1;
      if (checks % 3 === 0 && !closed) {
        try {
          const currentSession = sessions.requireSession(request);
          sessions.requireTenant(currentSession, tenantId);
        } catch {
          sendEvent("auth.expired.v1", { type: "auth.expired.v1" });
          close(true);
          return;
        }
      }
      if (!closed && !response.write(": keep-alive\n\n")) close(true);
    }, 5_000);
    heartbeat.unref?.();

    // Invalidation on connect also catches changes that happened during a reconnect.
    sendEvent("attendance.queue.changed.v1", {
      type: "attendance.queue.changed.v1",
      occurredAt: new Date().toISOString()
    });
  });

  app.put<{ Params: unknown; Body: unknown }>("/api/v1/tenants/:tenantId/config", async (request, reply) => {
    const { tenantId } = body(tenantParamsSchema, request.params);
    const session = await requireWrite(request, sessions);
    await sessions.requireAdmin(session, tenantId);
    const input = body<UpdateTenantConfigInput>(updateConfigSchema, request.body);
    return reply.send(service.updateConfig(tenantId, input));
  });

  app.get<{ Params: unknown; Querystring: unknown }>("/api/v1/tenants/:tenantId/conversations", async (request, reply) => {
    const { tenantId } = body(tenantParamsSchema, request.params);
    const query = body(conversationQuerySchema, request.query);
    const session = await requireSession(request, sessions);
    await sessions.requireTenant(session, tenantId);
    return reply.send({ conversations: service.listConversations(tenantId, query.state) });
  });

  app.get<{ Params: unknown }>("/api/v1/tenants/:tenantId/conversations/:conversationId", async (request, reply) => {
    const { tenantId, conversationId } = body(conversationParamsSchema, request.params);
    const session = await requireSession(request, sessions);
    await sessions.requireTenant(session, tenantId);
    return reply.send(service.getConversation(tenantId, conversationId));
  });

  app.post<{ Params: unknown; Body: unknown }>("/api/v1/tenants/:tenantId/simulate", async (request, reply) => {
    const { tenantId } = body(tenantParamsSchema, request.params);
    const session = await requireWrite(request, sessions);
    await sessions.requireTenant(session, tenantId);
    const input = body(simulateSchema, request.body);
    const result = await service.simulateMessage(tenantId, input);
    return reply.status(202).send(result);
  });

  app.post<{ Params: unknown; Body: unknown }>("/api/v1/tenants/:tenantId/conversations/:conversationId/handoff", async (request, reply) => {
    const { tenantId, conversationId } = body(conversationParamsSchema, request.params);
    const session = await requireWrite(request, sessions);
    await sessions.requireTenant(session, tenantId);
    noBody(request.body);
    return reply.send({ conversation: service.handoff(tenantId, conversationId) });
  });

  app.post<{ Params: unknown; Body: unknown }>("/api/v1/tenants/:tenantId/conversations/:conversationId/claim", async (request, reply) => {
    const { tenantId, conversationId } = body(conversationParamsSchema, request.params);
    const session = await requireWrite(request, sessions);
    await sessions.requireTenant(session, tenantId);
    noBody(request.body);
    return reply.send({ conversation: service.claim(tenantId, conversationId, session.user.id) });
  });

  app.post<{ Params: unknown; Body: unknown }>("/api/v1/tenants/:tenantId/conversations/:conversationId/reply", async (request, reply) => {
    const { tenantId, conversationId } = body(conversationParamsSchema, request.params);
    const session = await requireWrite(request, sessions);
    await sessions.requireTenant(session, tenantId);
    const { text } = body(replySchema, request.body);
    const result = service.reply(tenantId, conversationId, session.user, text);
    await service.processOutbox();
    const detail = service.getConversation(tenantId, conversationId);
    return reply.send({
      message: detail.messages.find((message) => message.id === result.message.id) ?? result.message,
      conversation: detail.conversation
    });
  });

  app.post<{ Params: unknown; Body: unknown }>("/api/v1/tenants/:tenantId/conversations/:conversationId/close", async (request, reply) => {
    const { tenantId, conversationId } = body(conversationParamsSchema, request.params);
    const session = await requireWrite(request, sessions);
    await sessions.requireTenant(session, tenantId);
    noBody(request.body);
    return reply.send({ conversation: service.close(tenantId, conversationId, session.user.id) });
  });

  app.post<{ Params: unknown; Body: unknown }>("/api/v1/tenants/:tenantId/conversations/:conversationId/resume", async (request, reply) => {
    const { tenantId, conversationId } = body(conversationParamsSchema, request.params);
    const session = await requireWrite(request, sessions);
    await sessions.requireTenant(session, tenantId);
    noBody(request.body);
    return reply.send({ conversation: service.resume(tenantId, conversationId, session.user.id) });
  });
}

