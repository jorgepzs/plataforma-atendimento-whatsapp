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
import type { CustomerMessageNotice, OutboundMessageNotice } from "./attendance/types.js";
import { registerAttendanceRoutes } from "./attendance/routes.js";
import { SqliteLocalDatabase } from "./infra/sqlite/local-database.js";
import { SqliteInboundEventStore } from "./infra/sqlite/sqlite-inbound-event-store.js";
import { OllamaKnowledgeAnswerSelector, type KnowledgeAnswerSelector } from "./attendance/knowledge-classifier.js";
import { createLlmAssistant, isPrivateLlmHost, OpenAiCompatibleChatClient, type LlmChatClient } from "./llm/index.js";
import { CloudApiTextSender } from "./infra/meta/cloud-api-text-sender.js";
import type { OutboundTextSender } from "./ports/outbound-text-sender.js";
import { allowPanelOrigins } from "./auth/local-sessions.js";
import { createWhatsAppChannel, type WhatsAppChannel } from "./whatsapp/channel.js";
import { registerWhatsAppRoutes } from "./whatsapp/routes.js";

declare module "fastify" {
  interface FastifyInstance { localAttendanceService?: LocalAttendanceService }
}

export interface BuildAppOptions {
  config: AppConfig;
  store: InboundEventStore;
  logger?: boolean;
  localDatabase?: SqliteLocalDatabase;
  knowledgeAnswerSelector?: KnowledgeAnswerSelector;
  llmClient?: LlmChatClient;
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
  if (options.config.whatsapp.enabled && (
    !(options.store instanceof SqliteInboundEventStore) ||
    !(options.localDatabase instanceof SqliteLocalDatabase) ||
    options.store.database !== options.localDatabase ||
    !options.config.whatsapp.sessionDir
  )) {
    throw new Error("O canal WhatsApp exige SQLite local e um diretório de sessão.");
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
                "req.body.llm.apiKey",
                "req.body.metaAccessToken",
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

  const llmSettings = options.config.llm;
  const llmClient = llmSettings
    ? options.llmClient ?? new OpenAiCompatibleChatClient({
        onLog: (event) => {
          const payload = {
            event: event.event,
            provider: event.provider,
            model: event.model,
            attempt: event.attempt,
            ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
            ...(event.toolsDegraded !== undefined ? { toolsDegraded: event.toolsDegraded } : {})
          };
          if (event.level === "warn") app.log.warn(payload, "Falha no provedor de IA.");
          else app.log.info(payload, "Provedor de IA respondeu sem ferramentas.");
        }
      })
    : undefined;
  if (llmSettings?.provider === "local") {
    app.log.warn(
      { model: llmSettings.model, privateHost: isPrivateLlmHost(llmSettings.baseUrl) },
      "IA local ativa. A máquina do modelo precisa permanecer ligada; OpenRouter é a opção indicada para produção."
    );
  }

  const webhookService = new MetaWebhookService(options.store);
  allowPanelOrigins(options.config.whatsapp.panelOrigins);

  const attendanceEnabled = Boolean(options.config.localDemoEnabled || options.config.whatsapp.enabled);
  if (attendanceEnabled && (options.store instanceof MemoryInboundEventStore || options.store instanceof SqliteInboundEventStore)) {
    const outboundSender = options.config.whatsappOutboundEnabled
      ? options.outboundSender ?? new CloudApiTextSender({
          enabled: true,
          graphApiVersion: options.config.metaGraphApiVersion,
          phoneNumberId: options.config.whatsappOutboundPhoneNumberId!,
          accessToken: options.config.whatsappOutboundAccessToken!
        })
      : undefined;
    const channelBridge: {
      customer?: (event: CustomerMessageNotice) => void;
      outbound?: (event: OutboundMessageNotice) => void;
    } = {};
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
        : {}),
      ...(llmSettings && llmClient ? { llmAssistant: createLlmAssistant(llmClient, llmSettings) } : {}),
      onCustomerMessage: (event) => channelBridge.customer?.(event),
      onOutboundMessage: (event) => channelBridge.outbound?.(event)
    });
    const sessions = new LocalSessionManager(Date.now, options.localDatabase?.identityRepository);
    let channel: WhatsAppChannel | undefined;
    if (options.config.whatsapp.enabled && options.store instanceof SqliteInboundEventStore) {
      channel = createWhatsAppChannel({
        config: options.config.whatsapp,
        graphApiVersion: options.config.metaGraphApiVersion,
        resolveChannelId: (tenantId) => {
          try {
            return service.getConfig(tenantId).tenant.channelPhoneNumberId;
          } catch {
            return undefined;
          }
        },
        enqueue: (message) => options.store.enqueue(message),
        onDelivery: (update) => service.markDelivery(update.tenantId, update.messageId, update),
        log: (level, payload, message) => {
          if (level === "warn") app.log.warn(payload, message);
          else app.log.info(payload, message);
        }
      });
      channelBridge.customer = (event) => channel?.handleCustomerMessage(event);
      channelBridge.outbound = (event) => channel?.handleOutbound(event);
    }
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
    await registerWhatsAppRoutes(app, sessions, channel);
    app.addHook("onReady", async () => { service.startWorker(); if (channel) await channel.start(); });
    app.addHook("preClose", async () => { await service.stopWorker(); if (channel) await channel.stop(); });
    app.addHook("onClose", async () => { sessions.close(); });
  }

  await registerHealthRoutes(app, options.store);
  await registerSystemRoutes(
    app,
    options.store,
    options.config.localDemoEnabled ?? false,
    options.config.localAiEnabled,
    options.config.whatsappOutboundEnabled,
    llmSettings ? { provider: llmSettings.provider, model: llmSettings.model } : null,
    options.config.whatsapp.enabled ? { provider: options.config.whatsapp.provider } : null
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

