import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AttendanceError, LocalAttendanceService } from "../attendance/service.js";
import { LocalHttpError, LocalSessionManager } from "../auth/local-sessions.js";
import type { SqliteLocalDatabase } from "../infra/sqlite/local-database.js";
import {
  consumerConfigInputSchema,
  consumerOrderDetailsContextSchema,
  normalizePublicBaseUrl,
  publicConsumerConfig,
  toConsumerCatalogMapping,
  toPersistedMappings,
  type ConsumerOrderDetailsContext
} from "./config.js";
import {
  buildConsumerPollingResponse,
  consumerStatusAck,
  ConsumerPartnerMappingError,
  parseConsumerSubmittedOrderDetails,
  parseConsumerStatusNotification
} from "./partner-api.js";
import { buildConsumerOrderDetailsResponse, type ConsumerQueryDetailsContext } from "./query-details.js";
import { SqliteConsumerRepository, type ConsumerPartnerConfigRecord } from "./repository.js";

interface ConsumerRouteOptions {
  database: SqliteLocalDatabase;
  service: LocalAttendanceService;
  sessions: LocalSessionManager;
  now?: () => Date;
  createToken?: () => string;
  createEventId?: () => string;
}

const tenantParams = z.object({ tenantId: z.string().trim().min(1).max(160) }).strict();
const orderParams = z.object({ orderId: z.string().trim().min(1).max(160) }).strict();

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function authenticateConsumer(request: FastifyRequest, repository: SqliteConsumerRepository): ConsumerPartnerConfigRecord | undefined {
  const value = request.headers.xapikey;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const hash = tokenHash(value);
  const config = repository.findEnabledByTokenHash(hash);
  return config && equalHash(hash, config.tokenHash) ? config : undefined;
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ statusCode: 401, reasonPhrase: "XApiKey inválida ou integração desativada." });
}

function integrationFailure(statusCode: number, reasonPhrase: string) {
  return { statusCode, reasonPhrase, item: null };
}

function eventTime(order: { confirmedAt: string | null; updatedAt: string }): string {
  return order.confirmedAt ?? order.updatedAt;
}

function detailsContext(config: ConsumerPartnerConfigRecord, value: Omit<ConsumerOrderDetailsContext, "merchant">): ConsumerQueryDetailsContext {
  return {
    displayId: value.displayId,
    merchant: { id: config.merchantId, name: config.merchantName },
    customer: {
      id: value.customer.id,
      name: value.customer.name,
      phone: value.customer.phone,
      phoneLocalizer: value.customer.phoneLocalizer,
      phoneLocalizerExpiration: value.customer.phoneLocalizerExpiration,
      ordersCountOnMerchant: value.customer.ordersCountOnMerchant,
      ...(value.customer.documentNumber === undefined ? {} : { documentNumber: value.customer.documentNumber })
    },
    payments: {
      prepaidCents: value.payments.prepaidCents,
      pendingCents: value.payments.pendingCents,
      methods: value.payments.methods.map((method) => ({
        method: method.method,
        type: method.type,
        prepaid: method.prepaid,
        valueCents: method.valueCents,
        ...(method.cardBrand === undefined ? {} : { cardBrand: method.cardBrand })
      }))
    },
    delivery: {
      mode: value.delivery.mode,
      deliveredBy: value.delivery.deliveredBy,
      pickupCode: value.delivery.pickupCode,
      deliveryDateTime: value.delivery.deliveryDateTime,
      ...(value.delivery.observations === undefined ? {} : { observations: value.delivery.observations }),
      address: {
        country: value.delivery.address.country,
        state: value.delivery.address.state,
        city: value.delivery.address.city,
        postalCode: value.delivery.address.postalCode,
        streetName: value.delivery.address.streetName,
        streetNumber: value.delivery.address.streetNumber,
        neighborhood: value.delivery.address.neighborhood,
        ...(value.delivery.address.complement === undefined ? {} : { complement: value.delivery.address.complement }),
        ...(value.delivery.address.reference === undefined ? {} : { reference: value.delivery.address.reference }),
        ...(value.delivery.address.coordinates ? { coordinates: value.delivery.address.coordinates } : {})
      }
    },
    ...(value.salesChannel !== undefined
      ? { salesChannel: value.salesChannel }
      : config.salesChannel ? { salesChannel: config.salesChannel } : {}),
    ...(value.preparationStartDateTime === undefined ? {} : { preparationStartDateTime: value.preparationStartDateTime })
  };
}

export async function registerConsumerRoutes(app: FastifyInstance, options: ConsumerRouteOptions): Promise<void> {
  const repository = new SqliteConsumerRepository(options.database);
  const now = options.now ?? (() => new Date());
  const newToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
  const newEventId = options.createEventId ?? (() => randomBytes(18).toString("base64url"));

  // Internal tenant-scoped configuration; the generated credential is returned only at creation/rotation.
  app.get("/api/v1/tenants/:tenantId/consumer", async (request) => {
    const { tenantId } = tenantParams.parse(request.params);
    const session = options.sessions.requireSession(request);
    options.sessions.requireTenant(session, tenantId);
    options.service.getConfig(tenantId);
    const config = repository.getConfig(tenantId);
    return { config: config ? publicConsumerConfig(config) : null };
  });

  app.put("/api/v1/tenants/:tenantId/consumer", async (request) => {
    const { tenantId } = tenantParams.parse(request.params);
    const session = options.sessions.requireSession(request);
    options.sessions.requireAdmin(session, tenantId);
    options.sessions.requireCsrf(request, session);
    options.service.getConfig(tenantId);
    const input = consumerConfigInputSchema.parse(request.body);
    const previous = repository.getConfig(tenantId);
    const apiToken = previous ? undefined : newToken();
    const secretHash = apiToken ? tokenHash(apiToken) : previous!.tokenHash;
    const updatedAt = now().toISOString();
    const enabledSince = input.enabled
      ? previous?.enabled
        ? previous.enabledSince ?? updatedAt
        : updatedAt
      : null;
    const tokenCreatedAt = apiToken ? updatedAt : previous!.tokenCreatedAt;
    const mappings = toPersistedMappings(input);
    options.database.transaction(() => repository.saveConfig({
      tenantId,
      enabled: input.enabled,
      enabledSince,
      publicBaseUrl: normalizePublicBaseUrl(input.publicBaseUrl),
      merchantId: input.merchantId,
      merchantName: input.merchantName,
      salesChannel: input.salesChannel || null,
      deliveryFeeReceivedBy: input.deliveryFeeReceivedBy ?? null,
      ...mappings,
      updatedAt
    }, secretHash, tokenCreatedAt));
    const saved = repository.getConfig(tenantId)!;
    return {
      config: publicConsumerConfig(saved),
      ...(apiToken ? { apiToken } : {})
    };
  });

  app.post("/api/v1/tenants/:tenantId/consumer/token/rotate", async (request) => {
    const { tenantId } = tenantParams.parse(request.params);
    const session = options.sessions.requireSession(request);
    options.sessions.requireAdmin(session, tenantId);
    options.sessions.requireCsrf(request, session);
    options.service.getConfig(tenantId);
    const config = repository.getConfig(tenantId);
    if (!config) throw new LocalHttpError(404, "consumer_config_not_found", "Configure a integração Consumer antes de gerar a chave.");
    const apiToken = newToken();
    const issuedAt = now().toISOString();
    if (!repository.rotateToken(tenantId, tokenHash(apiToken), issuedAt)) {
      throw new LocalHttpError(404, "consumer_config_not_found", "Configuração Consumer não encontrada.");
    }
    return { apiToken, tokenCreatedAt: issuedAt };
  });

  // Supplement order fields absent from CustomerOrder. This avoids fabricating
  // Consumer localizer, payment, pickup, address, or delivery-time values.
  app.put("/api/v1/tenants/:tenantId/consumer/orders/:orderId/details-context", async (request) => {
    const params = z.object({ tenantId: z.string(), orderId: z.string().trim().min(1).max(160) }).strict().parse(request.params);
    const { tenantId } = params;
    const session = options.sessions.requireSession(request);
    options.sessions.requireAdmin(session, tenantId);
    options.sessions.requireCsrf(request, session);
    const config = repository.getConfig(tenantId);
    if (!config) throw new LocalHttpError(404, "consumer_config_not_found", "Configure a integração Consumer antes dos dados do pedido.");
    options.service.getOrder(tenantId, params.orderId);
    const context = consumerOrderDetailsContextSchema.parse(request.body);
    repository.saveOrderDetailsContext(tenantId, params.orderId, context, now().toISOString());
    return { saved: true, orderId: params.orderId };
  });

  // Consumer Partner API: Consumer polls stable PLACED events by tenant credential.
  app.get("/api/Polling", async (request, reply) => {
    const config = authenticateConsumer(request, repository);
    if (!config) return unauthorized(reply);
    const orders = options.service.listOrders(config.tenantId)
      .filter((order) => (order.status === "confirmed" || order.status === "sent_to_integration") &&
        config.enabledSince !== null && Date.parse(eventTime(order)) >= Date.parse(config.enabledSince));
    const eventIds = new Map<string, string>();
    options.database.transaction(() => {
      for (const order of orders) {
        const event = repository.ensureOrderEvent(config.tenantId, order.id, newEventId(), eventTime(order));
        if (event.detailsRequestedAt === null) eventIds.set(order.id, event.eventId);
      }
    });
    const items = orders.flatMap((order) => {
      const eventId = eventIds.get(order.id);
      if (!eventId) return [];
      return buildConsumerPollingResponse(order, eventId).items;
    });
    return { items, statusCode: 0, reasonPhrase: null };
  });

  // Consumer's GET detail DTO is lowerCamelCase. The separate PascalCase
  // Consumer-to-partner POST is handled by /api/InfoOrderDetail below.
  app.get("/api/Order/:orderId", async (request, reply) => {
    const config = authenticateConsumer(request, repository);
    if (!config) return unauthorized(reply);
    const { orderId } = orderParams.parse(request.params);
    let order;
    try {
      order = options.service.getOrder(config.tenantId, orderId);
    } catch (error) {
      if (error instanceof AttendanceError && error.code === "order_not_found") {
        return reply.send(integrationFailure(404, "Pedido não localizado para esta empresa."));
      }
      throw error;
    }
    const storedContext = repository.getOrderDetailsContext<Omit<ConsumerOrderDetailsContext, "merchant">>(config.tenantId, orderId);
    if (!storedContext) {
      return reply.send(integrationFailure(5, "Detalhes Consumer ausentes: cadastre dados de pagamento, endereço, localizador e entrega antes da consulta."));
    }
    try {
      const item = buildConsumerOrderDetailsResponse(
        order,
        detailsContext(config, storedContext),
        toConsumerCatalogMapping(config)
      );
      repository.markOrderDetailsRequested(config.tenantId, orderId, now().toISOString());
      return reply.send(item);
    } catch (error) {
      if (error instanceof ConsumerPartnerMappingError) {
        return reply.send(integrationFailure(5, error.message));
      }
      throw error;
    }
  });

  // Consumer posts the PascalCase OrderDetail after ORDER_DETAILS_REQUESTED.
  // The receipt marks that per-tenant event complete; it does not re-write the
  // attendance snapshot or trust the posted DTO as a replacement local order.
  app.post("/api/InfoOrderDetail", async (request, reply) => {
    const config = authenticateConsumer(request, repository);
    if (!config) return unauthorized(reply);
    let submitted;
    try {
      submitted = parseConsumerSubmittedOrderDetails(request.body);
    } catch (error) {
      if (error instanceof ConsumerPartnerMappingError) {
        return reply.send({ statusCode: 5, reasonPhrase: error.message });
      }
      throw error;
    }
    try {
      options.service.getOrder(config.tenantId, submitted.Id);
    } catch (error) {
      if (error instanceof AttendanceError && error.code === "order_not_found") {
        return reply.send({ statusCode: 5, reasonPhrase: "Pedido não localizado para esta empresa." });
      }
      throw error;
    }
    const event = repository.getOrderEvent(config.tenantId, submitted.Id);
    if (!event) {
      return reply.send({ statusCode: 5, reasonPhrase: "Evento ORDER_DETAILS_REQUESTED não localizado para este pedido." });
    }
    repository.markOrderDetailsRequested(config.tenantId, submitted.Id, now().toISOString());
    return reply.send({ statusCode: 0, reasonPhrase: `${submitted.Id} enviado com sucesso.` });
  });

  // Consumer status notification. Only Confirmed/Cancelled map to local states;
  // ReadyToPickup/Dispatched are recorded verbatim because no local state matches.
  app.post("/api/Order", async (request, reply) => {
    const config = authenticateConsumer(request, repository);
    if (!config) return unauthorized(reply);
    let notification;
    try {
      notification = parseConsumerStatusNotification(request.body);
    } catch (error) {
      if (error instanceof ConsumerPartnerMappingError) return reply.send({ statusCode: 5, reasonPhrase: error.message });
      throw error;
    }
    const documentedStatuses = new Map([
      ["confirmed", "Confirmed"],
      ["cancelled", "Cancelled"],
      ["readytopickup", "ReadyToPickup"],
      ["dispatched", "Dispatched"],
      // The current manual's final-status example uses CONCLUDED, while the
      // public simulator enum omits it. Accept and record it without inventing
      // a local terminal state.
      ["concluded", "CONCLUDED"]
    ]);
    const status = documentedStatuses.get(notification.status.toLocaleLowerCase("en-US"));
    if (!status) {
      return reply.send({ statusCode: 5, reasonPhrase: "Status Consumer não documentado; nenhum estado local foi alterado." });
    }
    let order;
    try {
      order = options.service.getOrder(config.tenantId, notification.orderId);
    } catch (error) {
      if (error instanceof AttendanceError && error.code === "order_not_found") {
        return reply.send({ statusCode: 5, reasonPhrase: "Pedido não localizado para esta empresa." });
      }
      throw error;
    }
    const callbackHash = createHash("sha256").update(JSON.stringify([
      notification.orderId,
      status,
      notification.justification ?? null
    ])).digest("hex");
    if (repository.hasStatusCallback(config.tenantId, callbackHash)) return reply.send(consumerStatusAck());

    if (status === "Confirmed") {
      if (order.status === "confirmed") options.service.updateOrderStatus(config.tenantId, order.id, "sent_to_integration");
      else if (order.status !== "sent_to_integration") {
        return reply.send({ statusCode: 5, reasonPhrase: "O pedido não pode ser confirmado no estado local atual." });
      }
    } else if (status === "Cancelled" && order.status !== "cancelled") {
      try {
        options.service.updateOrderStatus(config.tenantId, order.id, "cancelled");
      } catch (error) {
        if (error instanceof AttendanceError && error.code === "invalid_order_status") {
          return reply.send({ statusCode: 5, reasonPhrase: "O cancelamento Consumer não pode ser aplicado ao estado local atual." });
        }
        throw error;
      }
    }

    repository.recordStatusCallback(
      config.tenantId,
      notification.orderId,
      callbackHash,
      status,
      notification.justification,
      now().toISOString()
    );
    return reply.send(consumerStatusAck(
      status === "ReadyToPickup" || status === "Dispatched" || status === "CONCLUDED"
        ? "Status recebido e registrado; não há estado equivalente no domínio local."
        : null
    ));
  });
}
