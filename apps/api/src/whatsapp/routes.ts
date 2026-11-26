import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireLocalOrigin, type LocalSessionManager } from "../auth/local-sessions.js";
import type { WhatsAppChannel } from "./channel.js";
import { digitsPhone } from "./text.js";

const tenantParamsSchema = z.strictObject({ tenantId: z.string().min(1).max(128) });
const phoneParamsSchema = tenantParamsSchema.extend({
  phone: z.string().regex(/^[1-9]\d{7,14}$/)
});
const settingsSchema = z.strictObject({
  provider: z.enum(["unofficial_qr", "meta_cloud"]).optional(),
  proactiveEnabled: z.boolean().optional(),
  messagesPerMinute: z.number().int().min(1).max(20).optional(),
  messagesPerHour: z.number().int().min(1).max(200).optional(),
  dailyCap: z.number().int().min(10).max(500).optional(),
  minDelayMs: z.number().int().min(500).max(60_000).optional(),
  maxDelayMs: z.number().int().min(500).max(120_000).optional(),
  firstMessageExtraDelayMs: z.number().int().min(0).max(120_000).optional(),
  quietHoursStart: z.number().int().min(0).max(23).optional(),
  quietHoursEnd: z.number().int().min(0).max(23).optional(),
  quietHoursTimeZone: z.string().min(1).max(80).optional(),
  warmupDays: z.number().int().min(1).max(30).optional(),
  maxLinksPerMessage: z.number().int().min(0).max(2).optional(),
  metaPhoneNumberId: z.string().regex(/^[1-9]\d{0,31}$/).nullable().optional(),
  metaAccessToken: z.string().min(1).max(8_192).regex(/^\S+$/).nullable().optional()
});

function sessionOf(request: FastifyRequest, sessions: LocalSessionManager) {
  requireLocalOrigin(request);
  return sessions.requireSession(request);
}

export async function registerWhatsAppRoutes(
  app: FastifyInstance,
  sessions: LocalSessionManager,
  channel: WhatsAppChannel | undefined
): Promise<void> {
  app.get<{ Params: unknown }>("/api/v1/tenants/:tenantId/whatsapp", async (request, reply) => {
    const { tenantId } = tenantParamsSchema.parse(request.params);
    const session = sessionOf(request, sessions);
    sessions.requireTenant(session, tenantId);
    if (!channel) return reply.send({ enabled: false });
    return reply.send(channel.view(tenantId));
  });

  app.get<{ Params: unknown }>("/api/v1/tenants/:tenantId/whatsapp/qr", async (request, reply) => {
    const { tenantId } = tenantParamsSchema.parse(request.params);
    const session = sessionOf(request, sessions);
    sessions.requireAdmin(session, tenantId);
    if (!channel) return reply.status(409).send({ error: "channel_disabled", message: "O canal WhatsApp não está ligado neste servidor." });
    const status = channel.view(tenantId);
    const qrDataUrl = status.provider === "unofficial_qr" ? await channel.provider.qrDataUrl(tenantId) : null;
    return reply.send({ ...status, qrDataUrl });
  });

  app.put<{ Params: unknown; Body: unknown }>("/api/v1/tenants/:tenantId/whatsapp", async (request, reply) => {
    const { tenantId } = tenantParamsSchema.parse(request.params);
    const session = sessionOf(request, sessions);
    sessions.requireCsrf(request, session);
    sessions.requireAdmin(session, tenantId);
    if (!channel) return reply.status(409).send({ error: "channel_disabled", message: "O canal WhatsApp não está ligado neste servidor." });
    const body = settingsSchema.parse(request.body);
    const policy = {
      ...(body.proactiveEnabled !== undefined ? { proactiveEnabled: body.proactiveEnabled } : {}),
      ...(body.messagesPerMinute !== undefined ? { messagesPerMinute: body.messagesPerMinute } : {}),
      ...(body.messagesPerHour !== undefined ? { messagesPerHour: body.messagesPerHour } : {}),
      ...(body.dailyCap !== undefined ? { dailyCap: body.dailyCap } : {}),
      ...(body.minDelayMs !== undefined ? { minDelayMs: body.minDelayMs } : {}),
      ...(body.maxDelayMs !== undefined ? { maxDelayMs: body.maxDelayMs } : {}),
      ...(body.firstMessageExtraDelayMs !== undefined ? { firstMessageExtraDelayMs: body.firstMessageExtraDelayMs } : {}),
      ...(body.quietHoursStart !== undefined ? { quietHoursStart: body.quietHoursStart } : {}),
      ...(body.quietHoursEnd !== undefined ? { quietHoursEnd: body.quietHoursEnd } : {}),
      ...(body.quietHoursTimeZone !== undefined ? { quietHoursTimeZone: body.quietHoursTimeZone } : {}),
      ...(body.warmupDays !== undefined ? { warmupDays: body.warmupDays } : {}),
      ...(body.maxLinksPerMessage !== undefined ? { maxLinksPerMessage: body.maxLinksPerMessage } : {})
    };
    return reply.send(channel.updateSettings(tenantId, {
      ...(body.provider ? { provider: body.provider } : {}),
      ...(Object.keys(policy).length > 0 ? { policy } : {}),
      ...(body.metaPhoneNumberId !== undefined ? { metaPhoneNumberId: body.metaPhoneNumberId } : {}),
      ...(body.metaAccessToken !== undefined ? { metaAccessToken: body.metaAccessToken } : {})
    }));
  });

  app.post<{ Params: unknown }>("/api/v1/tenants/:tenantId/whatsapp/connect", async (request, reply) => {
    const { tenantId } = tenantParamsSchema.parse(request.params);
    const session = sessionOf(request, sessions);
    sessions.requireCsrf(request, session);
    sessions.requireAdmin(session, tenantId);
    if (!channel) return reply.status(409).send({ error: "channel_disabled", message: "O canal WhatsApp não está ligado neste servidor." });
    await channel.provider.connect(tenantId);
    return reply.send(channel.view(tenantId));
  });

  app.post<{ Params: unknown }>("/api/v1/tenants/:tenantId/whatsapp/disconnect", async (request, reply) => {
    const { tenantId } = tenantParamsSchema.parse(request.params);
    const session = sessionOf(request, sessions);
    sessions.requireCsrf(request, session);
    sessions.requireAdmin(session, tenantId);
    if (!channel) return reply.status(409).send({ error: "channel_disabled", message: "O canal WhatsApp não está ligado neste servidor." });
    await channel.provider.disconnect(tenantId);
    return reply.send(channel.view(tenantId));
  });

  app.post<{ Params: unknown }>("/api/v1/tenants/:tenantId/whatsapp/logout", async (request, reply) => {
    const { tenantId } = tenantParamsSchema.parse(request.params);
    const session = sessionOf(request, sessions);
    sessions.requireCsrf(request, session);
    sessions.requireAdmin(session, tenantId);
    if (!channel) return reply.status(409).send({ error: "channel_disabled", message: "O canal WhatsApp não está ligado neste servidor." });
    await channel.provider.logout(tenantId);
    return reply.send(channel.view(tenantId));
  });

  app.get<{ Params: unknown }>("/api/v1/tenants/:tenantId/whatsapp/contacts/:phone", async (request, reply) => {
    const { tenantId, phone } = phoneParamsSchema.parse(request.params);
    const session = sessionOf(request, sessions);
    sessions.requireTenant(session, tenantId);
    if (!channel) {
      return reply.send({ available: false, phone, known: false, optedOut: false, optedIn: false });
    }
    return reply.send({ available: true, phone, ...channel.provider.contactConsent(tenantId, phone) });
  });

  app.post<{ Params: unknown }>("/api/v1/tenants/:tenantId/whatsapp/contacts/:phone/opt-in", async (request, reply) => {
    const { tenantId, phone } = phoneParamsSchema.parse(request.params);
    const session = sessionOf(request, sessions);
    sessions.requireCsrf(request, session);
    sessions.requireAdmin(session, tenantId);
    if (!channel) return reply.status(409).send({ error: "channel_disabled", message: "O canal WhatsApp não está ligado neste servidor." });
    const changed = channel.provider.setOptIn(tenantId, phone, true);
    if (!changed) return reply.status(409).send({ error: "no_prior_inbound", message: "Opt-in só vale para um contato que já mandou mensagem." });
    return reply.send({ phone: digitsPhone(phone), optedIn: true });
  });

  app.post<{ Params: unknown }>("/api/v1/tenants/:tenantId/whatsapp/contacts/:phone/resume", async (request, reply) => {
    const { tenantId, phone } = phoneParamsSchema.parse(request.params);
    const session = sessionOf(request, sessions);
    sessions.requireCsrf(request, session);
    sessions.requireAdmin(session, tenantId);
    if (!channel) return reply.status(409).send({ error: "channel_disabled", message: "O canal WhatsApp não está ligado neste servidor." });
    channel.provider.clearOptOut(tenantId, phone);
    return reply.send({ phone: digitsPhone(phone), optedOut: false });
  });
}
