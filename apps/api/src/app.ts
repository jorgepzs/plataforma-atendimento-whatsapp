import Fastify, { type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { InboundEventStore } from "./ports/inbound-event-store.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetaWebhookRoutes } from "./routes/meta-webhook.js";
import { registerSystemRoutes } from "./routes/system.js";
import { MetaWebhookService } from "./services/meta-webhook-service.js";
import { MemoryInboundEventStore } from "./infra/memory/memory-inbound-event-store.js";
import { LocalSessionManager, LocalHttpError } from "./auth/local-sessions.js";
import { registerLocalAuthRoutes } from "./auth/local-auth-routes.js";
import { LocalAttendanceService, AttendanceError } from "./attendance/service.js";
import { registerAttendanceRoutes } from "./attendance/routes.js";
import { SqliteLocalDatabase } from "./infra/sqlite/local-database.js";
import { SqliteInboundEventStore } from "./infra/sqlite/sqlite-inbound-event-store.js";
import { OllamaKnowledgeAnswerSelector, type KnowledgeAnswerSelector } from "./attendance/knowledge-classifier.js";
import { CloudApiTextSender } from "./infra/meta/cloud-api-text-sender.js";
import type { OutboundTextSender } from "./ports/outbound-text-sender.js";

declare module "fastify" {
  interface FastifyInstance { localAttendanceService?: LocalAttendanceService }
}

export interface BuildAppOptions {
  config: AppConfig;
  store: InboundEventStore;
  logger?: boolean;
  localDatabase?: SqliteLocalDatabase;
  knowledgeAnswerSelector?: KnowledgeAnswerSelector;
  outboundSender?: OutboundTextSender;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  if (options.config.localAiEnabled && (
    !options.config.localDemoEnabled || options.config.nodeEnv === "production" ||
    !["127.0.0.1", "localhost", "::1"].includes(options.config.host) || !options.config.localAiModel
  )) {
    throw new Error("A IA local exige demonstração habilitada, modelo configurado e API em loopback fora de produção.");
  }
  if (options.config.localDemoEnabled && (
    options.config.nodeEnv === "production" || options.config.databaseUrl ||
    !(options.store instanceof MemoryInboundEventStore || (
      options.store instanceof SqliteInboundEventStore && options.localDatabase instanceof SqliteLocalDatabase &&
      options.store.database === options.localDatabase
    )) ||
    !["127.0.0.1", "localhost", "::1"].includes(options.config.host)
  )) {
    throw new Error("O atendimento local exige ambiente não produtivo, host loopback e store local de memória ou SQLite.");
  }
  if (options.localDatabase && (!options.config.localDemoEnabled || !(options.store instanceof SqliteInboundEventStore) || options.store.database !== options.localDatabase)) {
    throw new Error("O banco local deve pertencer ao store SQLite e ao atendimento local habilitado.");
  }
  if (options.config.whatsappOutboundEnabled && (
    !options.config.localDemoEnabled || options.config.nodeEnv === "production" || options.config.databaseUrl ||
    !["127.0.0.1", "localhost", "::1"].includes(options.config.host) ||
    !options.config.localSqlitePath || !(options.store instanceof SqliteInboundEventStore) ||
    !(options.localDatabase instanceof SqliteLocalDatabase) || options.store.database !== options.localDatabase ||
    !options.config.whatsappOutboundPhoneNumberId || !options.config.whatsappOutboundAccessToken ||
    options.config.whatsappOutboundAllowedRecipients.length === 0
  )) {
    throw new Error("O envio WhatsApp de teste exige demo local com SQLite, loopback, ambiente não produtivo e canal, token privado e destinatários permitidos.");
  }
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.logLevel,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "req.headers.x-csrf-token",
                "res.headers.set-cookie",
                "req.body.password",
                "req.headers.x-hub-signature-256",
                "req.body.entry[*].changes[*].value.contacts",
                "req.body.entry[*].changes[*].value.messages"
              ],
              censor: "[REDACTED]"
            }
          },
    bodyLimit: 2 * 1024 * 1024
  });

  await app.register(rawBody, {
    field: "rawBody",
    global: true,
    encoding: false,
    runFirst: true
  });

  const webhookService = new MetaWebhookService(options.store);

  if (options.config.localDemoEnabled && (options.store instanceof MemoryInboundEventStore || options.store instanceof SqliteInboundEventStore)) {
    const outboundSender = options.config.whatsappOutboundEnabled
      ? options.outboundSender ?? new CloudApiTextSender({
          enabled: true,
          graphApiVersion: options.config.metaGraphApiVersion,
          phoneNumberId: options.config.whatsappOutboundPhoneNumberId!,
          accessToken: options.config.whatsappOutboundAccessToken!
        })
      : undefined;
    const service = new LocalAttendanceService(options.store, {
      ...(options.localDatabase ? { repository: options.localDatabase.attendanceRepository } : {}),
      outbound: {
        enabled: options.config.whatsappOutboundEnabled,
        graphApiVersion: options.config.metaGraphApiVersion,
        allowedRecipients: options.config.whatsappOutboundAllowedRecipients,
        ...(options.config.whatsappOutboundEnabled ? { maxTotalAttempts: 1 } : {}),
        ...(options.config.whatsappOutboundPhoneNumberId ? { phoneNumberId: options.config.whatsappOutboundPhoneNumberId } : {}),
        ...(options.config.whatsappOutboundAccessToken ? { accessToken: options.config.whatsappOutboundAccessToken } : {}),
        ...(outboundSender ? { sender: outboundSender } : {})
      },
      ...(options.config.localAiEnabled && options.config.localAiModel
        ? { knowledgeAnswerSelector: options.knowledgeAnswerSelector ?? new OllamaKnowledgeAnswerSelector({ model: options.config.localAiModel }) }
        : {})
    });
    const sessions = new LocalSessionManager(Date.now, options.localDatabase?.identityRepository);
    app.decorate("localAttendanceService", service);
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.startsWith("/api/v1/")) reply.header("cache-control", "no-store");
    });
    await registerLocalAuthRoutes(app, sessions);
    await registerAttendanceRoutes(app, service, sessions, options.localDatabase ? (input, userId) => {
      try {
        return options.localDatabase!.transaction(() => {
          const tenant = service.createTenant(input);
          sessions.addMembership(userId, tenant.id, "TENANT_ADMIN");
          return tenant;
        });
      } catch (error) {
        service.reloadFromRepository();
        sessions.reloadFromRepository();
        throw error;
      }
    } : undefined);
    app.addHook("onReady", async () => { service.startWorker(); });
    app.addHook("preClose", async () => { await service.stopWorker(); });
    app.addHook("onClose", async () => { sessions.close(); });
  }

  await registerHealthRoutes(app, options.store);
  await registerSystemRoutes(
    app,
    options.store,
    options.config.localDemoEnabled ?? false,
    options.config.localAiEnabled,
    options.config.whatsappOutboundEnabled
  );
  await registerMetaWebhookRoutes(app, options.config, webhookService);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn({ issueCount: error.issues.length }, "Payload inválido.");
      return reply.status(400).send({ error: "invalid_payload" });
    }

    if (error instanceof LocalHttpError || error instanceof AttendanceError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }

    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;

    request.log.error({ error }, "Falha ao processar a requisição.");
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? "internal_server_error" : "request_failed"
    });
  });

  app.addHook("onClose", async () => {
    await options.store.close();
  });

  return app;
}

