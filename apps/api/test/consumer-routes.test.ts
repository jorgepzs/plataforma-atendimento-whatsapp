import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { SqliteLocalDatabase } from "../src/infra/sqlite/local-database.js";
import { SqliteInboundEventStore } from "../src/infra/sqlite/sqlite-inbound-event-store.js";
import { SqliteConsumerRepository } from "../src/consumer/repository.js";
import type { CustomerOrder } from "../src/ordering/types.js";
import { testConfig } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;
type Session = { cookie: string; csrfToken: string };

const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function makeOrder(id: string, tenantId: string, conversationId: string): CustomerOrder {
  return {
    id,
    tenantId,
    conversationId,
    status: "confirmed",
    lines: [{
      lineId: `line-${id}`,
      itemId: "calabresa",
      name: "Pizza Calabresa Grande",
      quantity: 1,
      unitPriceCents: 7100,
      choices: [
        { groupId: "size", choiceId: "grande", name: "Grande", priceCents: 1500 },
        { groupId: "extra", choiceId: "cheddar", name: "Borda cheddar", priceCents: 800 }
      ],
      lineTotalCents: 7100
    }],
    fulfillment: { method: "delivery", address: "Rua A, 10", notes: "Casa azul" },
    subtotalCents: 7100,
    deliveryFeeCents: 800,
    totalCents: 7900,
    currency: "BRL",
    summaryPresentedAt: "2026-11-26T19:59:00.000Z",
    confirmedAt: "2026-11-26T20:01:00.000Z",
    cancelledAt: null,
    integrationReference: null,
    integrationError: null,
    createdAt: "2026-11-26T19:58:00.000Z",
    updatedAt: "2026-11-26T20:01:00.000Z"
  };
}

async function startApp(): Promise<{ app: App; database: SqliteLocalDatabase; setNow: (value: Date) => void }> {
  const database = new SqliteLocalDatabase(":memory:");
  const store = new SqliteInboundEventStore(database);
  let currentTime = new Date("2026-11-26T20:00:00.000Z");
  const app = await buildApp({
    config: { ...testConfig, localDemoEnabled: true },
    store,
    localDatabase: database,
    now: () => currentTime,
    logger: false
  });
  apps.push(app);
  await app.ready();
  await app.localAttendanceService!.stopWorker();

  const snapshot = database.attendanceRepository.load()!;
  for (const [tenantId, orderId, phone] of [
    ["pizzaria-demo", "pizza-order", "5511990000101"],
    ["pizzaria-demo", "pizza-cancel-order", "5511990000103"],
    ["barbearia-demo", "barber-order", "5511990000102"]
  ] as const) {
    const conversationId = `conversation-${orderId}`;
    snapshot.conversations.push({
      id: conversationId,
      tenantId,
      customerName: "Ana Cliente",
      customerPhone: phone,
      state: "BOT_ACTIVE",
      assignedUserId: null,
      createdAt: "2026-11-26T19:58:00.000Z",
      updatedAt: "2026-11-26T20:01:00.000Z",
      lastMessagePreview: "Quero pedir",
      waitingSince: null,
      lastInboundMessageId: null,
      lastInboundSource: null,
      lastInboundPhoneNumberId: null,
      lastInboundAt: null
    });
    const order = makeOrder(orderId, tenantId, conversationId);
    if (orderId === "pizza-cancel-order") {
      order.confirmedAt = "2026-11-26T19:59:00.000Z";
      order.updatedAt = order.confirmedAt;
    }
    snapshot.orders = [...(snapshot.orders ?? []), order];
  }
  database.attendanceRepository.save(snapshot);
  app.localAttendanceService!.reloadFromRepository();
  return { app, database, setNow: (value) => { currentTime = value; } };
}

async function login(app: App, email = "admin@atende.local"): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "AtendeLocal123!" }
  });
  expect(response.statusCode).toBe(200);
  const rawCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  return { cookie: cookieHeader!.split(";", 1)[0]!, csrfToken: response.json().csrfToken as string };
}

function adminHeaders(session: Session) {
  return { cookie: session.cookie, "x-csrf-token": session.csrfToken };
}

const configPayload = {
  enabled: true,
  publicBaseUrl: "https://partner.example.test",
  merchantId: "consumer-merchant-1",
  merchantName: "Pizzaria Demo",
  salesChannel: "WHATSAPP",
  deliveryFeeReceivedBy: "MERCHANT" as const,
  productMappings: [{ itemId: "calabresa", choiceIds: ["grande"], externalCode: "PDV-PIZZA-CAL-G" }],
  optionMappings: [{ choiceId: "cheddar", externalCode: "PDV-COMPL-CHEDDAR" }],
  variantChoiceIdsByItemId: { calabresa: ["grande"] }
};

const orderDetailsContext = {
  displayId: "0001",
  customer: {
    id: "customer-1",
    name: "Ana Cliente",
    phone: "+5511990000101",
    phoneLocalizer: "localizer-123",
    phoneLocalizerExpiration: "2026-11-26T21:00:00.000Z",
    ordersCountOnMerchant: 0
  },
  payments: {
    prepaidCents: 0,
    pendingCents: 7900,
    methods: [{ method: "PIX", type: "OFFLINE", prepaid: false, valueCents: 7900 }]
  },
  delivery: {
    mode: "DEFAULT",
    deliveredBy: "Partner",
    pickupCode: "1234",
    deliveryDateTime: "2026-11-26T20:45:00.000Z",
    address: {
      country: "BR",
      state: "SP",
      city: "Campinas",
      postalCode: "13000000",
      streetName: "Rua A",
      streetNumber: "10",
      neighborhood: "Centro",
      complement: "",
      reference: "Casa azul"
    }
  }
};

async function configureTenant(app: App, session: Session, tenantId = "pizzaria-demo") {
  return app.inject({
    method: "PUT",
    url: `/api/v1/tenants/${tenantId}/consumer`,
    headers: adminHeaders(session),
    payload: configPayload
  });
}

describe("Consumer Partner API routes", () => {
  it("protects tenant config and Consumer endpoints with separate auth scopes", async () => {
    const { app } = await startApp();
    const admin = await login(app);
    const created = await configureTenant(app, admin);
    expect(created.statusCode).toBe(200);
    const { apiToken } = created.json() as { apiToken: string };
    expect(apiToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const getConfig = await app.inject({
      url: "/api/v1/tenants/pizzaria-demo/consumer",
      headers: { cookie: admin.cookie }
    });
    expect(getConfig.statusCode).toBe(200);
    expect(getConfig.json().config).toMatchObject({
      tokenConfigured: true,
      enabled: true,
      endpoints: { infoOrderDetail: "https://partner.example.test/api/InfoOrderDetail" }
    });
    expect(JSON.stringify(getConfig.json())).not.toContain(apiToken);
    expect(JSON.stringify(getConfig.json())).not.toContain("tokenHash");

    expect((await app.inject({ url: "/api/Polling" })).statusCode).toBe(401);
    const polling = await app.inject({ url: "/api/Polling", headers: { XApiKey: apiToken } });
    expect(polling.statusCode).toBe(200);
    expect(polling.json()).toMatchObject({ statusCode: 0, reasonPhrase: null });

    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/tenants/pizzaria-demo/consumer/token/rotate",
      headers: adminHeaders(admin)
    });
    expect(rotated.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/Polling", headers: { XApiKey: apiToken } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/Polling", headers: { XApiKey: rotated.json().apiToken as string } })).statusCode).toBe(200);
  });

  it("does not poll orders confirmed before activation and keeps new events stable until details are served", async () => {
    const { app } = await startApp();
    const admin = await login(app);
    const created = await configureTenant(app, admin);
    const apiToken = created.json().apiToken as string;
    const headers = { XApiKey: apiToken };

    const firstPoll = await app.inject({ url: "/api/Polling", headers });
    const secondPoll = await app.inject({ url: "/api/Polling", headers });
    expect(firstPoll.json().items).toHaveLength(1);
    expect(secondPoll.json().items).toEqual(firstPoll.json().items);
    expect(firstPoll.json().items[0]).toMatchObject({ fullCode: "PLACED", code: "PLC" });

    const context = await app.inject({
      method: "PUT",
      url: "/api/v1/tenants/pizzaria-demo/consumer/orders/pizza-order/details-context",
      headers: adminHeaders(admin),
      payload: orderDetailsContext
    });
    expect(context.statusCode).toBe(200);

    const details = await app.inject({ url: "/api/Order/pizza-order", headers });
    expect(details.json()).toMatchObject({
      statusCode: 0,
      item: {
        id: "pizza-order",
        orderType: "DELIVERY",
        merchant: { id: "consumer-merchant-1", name: "Pizzaria Demo" },
        customer: { phone: { localizer: "localizer-123" } },
        items: [{ externalCode: "PDV-PIZZA-CAL-G", options: [{ externalCode: "PDV-COMPL-CHEDDAR" }] }]
      }
    });
    expect(details.json().item).not.toHaveProperty("Id");
    expect((await app.inject({ url: "/api/Polling", headers })).json().items).toHaveLength(0);

  });

  it("starts a new polling window when the integration is re-enabled", async () => {
    const { app, setNow } = await startApp();
    const admin = await login(app);
    const created = await configureTenant(app, admin);
    const apiToken = created.json().apiToken as string;
    const headers = { XApiKey: apiToken };

    setNow(new Date("2026-11-26T20:01:00.000Z"));
    await app.inject({
      method: "PUT",
      url: "/api/v1/tenants/pizzaria-demo/consumer",
      headers: adminHeaders(admin),
      payload: { ...configPayload, enabled: false }
    });
    setNow(new Date("2026-11-26T20:02:00.000Z"));
    await app.inject({
      method: "PUT",
      url: "/api/v1/tenants/pizzaria-demo/consumer",
      headers: adminHeaders(admin),
      payload: configPayload
    });

    const polling = await app.inject({ url: "/api/Polling", headers });
    expect(polling.json().items).toEqual([]);
  });

  it("returns explicit errors for missing details and prevents cross-tenant order access", async () => {
    const { app } = await startApp();
    const admin = await login(app);
    const pizzaConfig = await configureTenant(app, admin, "pizzaria-demo");
    const pizzaToken = pizzaConfig.json().apiToken as string;
    const barberConfig = await configureTenant(app, admin, "barbearia-demo");
    const barberToken = barberConfig.json().apiToken as string;

    const missing = await app.inject({ url: "/api/Order/pizza-order", headers: { XApiKey: pizzaToken } });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({ statusCode: 5, item: null });
    expect(missing.json().reasonPhrase).toContain("localizador");

    const wrongTenant = await app.inject({ url: "/api/Order/barber-order", headers: { XApiKey: pizzaToken } });
    expect(wrongTenant.json()).toMatchObject({ statusCode: 404, item: null });
    const ownTenant = await app.inject({ url: "/api/Order/barber-order", headers: { XApiKey: barberToken } });
    expect(ownTenant.json()).toMatchObject({ statusCode: 5, item: null });
  });

  it("accepts Consumer's PascalCase InfoOrderDetail only for the authenticated tenant and completes it idempotently", async () => {
    const { app, database } = await startApp();
    const admin = await login(app);
    const pizzaConfig = await configureTenant(app, admin, "pizzaria-demo");
    const pizzaToken = pizzaConfig.json().apiToken as string;
    const barberConfig = await configureTenant(app, admin, "barbearia-demo");
    const barberToken = barberConfig.json().apiToken as string;
    const pizzaHeaders = { XApiKey: pizzaToken };
    const barberHeaders = { XApiKey: barberToken };

    expect((await app.inject({ method: "POST", url: "/api/InfoOrderDetail", payload: { Id: "pizza-order" } })).statusCode).toBe(401);
    await app.inject({ url: "/api/Polling", headers: pizzaHeaders });
    await app.inject({ url: "/api/Polling", headers: barberHeaders });
    const repository = new SqliteConsumerRepository(database);
    const originalEvent = repository.getOrderEvent("pizzaria-demo", "pizza-order");
    expect(originalEvent?.detailsRequestedAt).toBeNull();

    const missingPascalId = await app.inject({
      method: "POST", url: "/api/InfoOrderDetail", headers: pizzaHeaders, payload: { id: "pizza-order" }
    });
    expect(missingPascalId.json()).toMatchObject({ statusCode: 5 });

    const otherTenant = await app.inject({
      method: "POST", url: "/api/InfoOrderDetail", headers: pizzaHeaders, payload: { Id: "barber-order" }
    });
    expect(otherTenant.json()).toMatchObject({ statusCode: 5, reasonPhrase: "Pedido não localizado para esta empresa." });
    expect(repository.getOrderEvent("barbearia-demo", "barber-order")?.detailsRequestedAt).toBeNull();

    const snapshotBefore = database.attendanceRepository.load();
    const first = await app.inject({
      method: "POST", url: "/api/InfoOrderDetail", headers: pizzaHeaders, payload: { Id: " pizza-order ", Type: "DELIVERY" }
    });
    expect(first.json()).toEqual({ statusCode: 0, reasonPhrase: "pizza-order enviado com sucesso." });
    const completedAt = repository.getOrderEvent("pizzaria-demo", "pizza-order")?.detailsRequestedAt;
    expect(completedAt).toEqual(expect.any(String));

    const duplicate = await app.inject({
      method: "POST", url: "/api/InfoOrderDetail", headers: pizzaHeaders, payload: { Id: "pizza-order", Type: "DELIVERY" }
    });
    expect(duplicate.json()).toEqual(first.json());
    expect(repository.getOrderEvent("pizzaria-demo", "pizza-order")?.detailsRequestedAt).toBe(completedAt);
    expect(database.attendanceRepository.load()).toEqual(snapshotBefore);
    expect(app.localAttendanceService!.getOrder("pizzaria-demo", "pizza-order").status).toBe("confirmed");
    expect((await app.inject({ url: "/api/Polling", headers: pizzaHeaders })).json().items).toHaveLength(0);
  });

  it("maps only documented confirmation/cancellation statuses and keeps callbacks idempotent", async () => {
    const { app, database } = await startApp();
    const admin = await login(app);
    const created = await configureTenant(app, admin);
    const apiToken = created.json().apiToken as string;
    const headers = { XApiKey: apiToken };

    const confirmed = await app.inject({ method: "POST", url: "/api/Order", headers, payload: { orderId: "pizza-order", status: "Confirmed" } });
    expect(confirmed.json()).toEqual({ statusCode: 0, reasonPhrase: null });
    expect(app.localAttendanceService!.getOrder("pizzaria-demo", "pizza-order").status).toBe("sent_to_integration");
    const duplicate = await app.inject({ method: "POST", url: "/api/Order", headers, payload: { orderId: "pizza-order", status: "Confirmed" } });
    expect(duplicate.json()).toEqual(confirmed.json());
    expect(new SqliteConsumerRepository(database).countStatusCallbacks("pizzaria-demo", "pizza-order")).toBe(1);

    const ready = await app.inject({ method: "POST", url: "/api/Order", headers, payload: { orderId: "pizza-order", status: "ReadyToPickup" } });
    expect(ready.json().statusCode).toBe(0);
    expect(app.localAttendanceService!.getOrder("pizzaria-demo", "pizza-order").status).toBe("sent_to_integration");

    const cancelledAfterAcceptance = await app.inject({ method: "POST", url: "/api/Order", headers, payload: { orderId: "pizza-order", status: "Cancelled" } });
    expect(cancelledAfterAcceptance.json()).toEqual({ statusCode: 0, reasonPhrase: null });
    expect(app.localAttendanceService!.getOrder("pizzaria-demo", "pizza-order").status).toBe("cancelled");

    const cancelled = await app.inject({ method: "POST", url: "/api/Order", headers, payload: { orderId: "pizza-cancel-order", status: "Cancelled" } });
    expect(cancelled.json()).toEqual({ statusCode: 0, reasonPhrase: null });
    expect(app.localAttendanceService!.getOrder("pizzaria-demo", "pizza-cancel-order").status).toBe("cancelled");
    const wrongTenant = await app.inject({ method: "POST", url: "/api/Order", headers, payload: { orderId: "barber-order", status: "Cancelled" } });
    expect(wrongTenant.json().statusCode).toBe(5);
    const notDocumented = await app.inject({ method: "POST", url: "/api/Order", headers, payload: { orderId: "pizza-order", status: "Delivered" } });
    expect(notDocumented.json()).toMatchObject({ statusCode: 5 });
    expect(app.localAttendanceService!.getOrder("pizzaria-demo", "pizza-order").status).toBe("cancelled");

    const concluded = await app.inject({ method: "POST", url: "/api/Order", headers, payload: { orderId: "pizza-order", status: "CONCLUDED" } });
    expect(concluded.json()).toMatchObject({ statusCode: 0, reasonPhrase: "Status recebido e registrado; não há estado equivalente no domínio local." });
    expect(app.localAttendanceService!.getOrder("pizzaria-demo", "pizza-order").status).toBe("cancelled");
    expect(new SqliteConsumerRepository(database).countStatusCallbacks("pizzaria-demo", "pizza-order")).toBe(4);
  });
});
