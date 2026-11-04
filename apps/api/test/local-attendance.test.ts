import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { createMetaSignature } from "../src/meta/signature.js";
import { testConfig } from "./helpers.js";
import type { KnowledgeAnswerSelector } from "../src/attendance/knowledge-classifier.js";

const DEMO_PASSWORD = "AtendeLocal123!";
const PIZZARIA = "pizzaria-demo";
const BARBEARIA = "barbearia-demo";
const FAQ_QUESTION = "Qual é o horário de funcionamento?";
const FAQ_ANSWER = "Atendemos de terça a domingo, das 11h às 22h.";

type BuiltApp = Awaited<ReturnType<typeof buildApp>>;
type Session = {
  cookie: string;
  csrfToken: string;
  user: { id: string; email: string; platformAdmin: boolean };
};
type Conversation = {
  id: string;
  tenantId: string;
  customerPhone: string;
  state: "BOT_ACTIVE" | "WAITING_HUMAN" | "HUMAN_ACTIVE" | "CLOSED";
  assignedUserId: string | null;
};
type Message = {
  role: "CUSTOMER" | "BOT" | "ATTENDANT";
  text: string;
  deliveryStatus: "RECEIVED" | "SIMULATED";
};

const apps: BuiltApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function makeApp(options: { localAiEnabled?: boolean; knowledgeAnswerSelector?: KnowledgeAnswerSelector } = {}) {
  const config = {
    ...testConfig,
    localDemoEnabled: true,
    localAiEnabled: options.localAiEnabled ?? false,
    ...(options.localAiEnabled ? { localAiModel: "test-model" } : {})
  } as AppConfig;
  const store = new MemoryInboundEventStore();
  const app = await buildApp({ config, store, logger: false, ...(options.knowledgeAnswerSelector ? { knowledgeAnswerSelector: options.knowledgeAnswerSelector } : {}) });
  apps.push(app);
  await app.ready();
  if (!app.localAttendanceService) {
    throw new Error("buildApp não expôs LocalAttendanceService no modo demo.");
  }
  await app.localAttendanceService.stopWorker();
  return { app, store };
}

async function login(app: BuiltApp, email: string, password = DEMO_PASSWORD): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password }
  });
  expect(response.statusCode).toBe(200);

  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(cookieHeader).toBeDefined();
  expect(cookieHeader).toContain("HttpOnly");
  expect(cookieHeader).toContain("SameSite=Strict");
  expect(cookieHeader).toContain("Path=/");

  const body = response.json<Session & { expiresAt: string }>();
  expect(body.csrfToken).toEqual(expect.any(String));
  expect(body.expiresAt).toEqual(expect.any(String));
  return {
    cookie: cookieHeader!.split(";", 1)[0]!,
    csrfToken: body.csrfToken,
    user: body.user
  };
}

function headers(session: Session, csrf = true) {
  return {
    cookie: session.cookie,
    ...(csrf ? { "x-csrf-token": session.csrfToken } : {})
  };
}

function tenantPath(tenantId: string, resource: string) {
  return `/api/v1/tenants/${tenantId}/${resource}`;
}

function conversationPath(tenantId: string, conversationId: string, action = "") {
  return `${tenantPath(tenantId, `conversations/${encodeURIComponent(conversationId)}`)}${action ? `/${action}` : ""}`;
}

async function processPending(app: BuiltApp) {
  if (!app.localAttendanceService) {
    throw new Error("LocalAttendanceService está indisponível.");
  }
  await app.localAttendanceService.processPending();
}

async function postSignedWebhook(app: BuiltApp, payload: unknown) {
  const rawBody = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: "/webhooks/meta",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": createMetaSignature(Buffer.from(rawBody), "app-secret")
    },
    payload: rawBody
  });
}

async function simulate(
  app: BuiltApp,
  session: Session,
  tenantId: string,
  text: string,
  customerPhone: string,
  clientMessageId: string
) {
  return app.inject({
    method: "POST",
    url: tenantPath(tenantId, "simulate"),
    headers: headers(session),
    payload: { customerName: "Cliente de teste", customerPhone, text, clientMessageId }
  });
}

async function getConversation(app: BuiltApp, session: Session, tenantId: string, id: string) {
  return app.inject({ method: "GET", url: conversationPath(tenantId, id), headers: headers(session, false) });
}

async function configureFaq(
  app: BuiltApp,
  session: Session,
  tenantId = PIZZARIA,
  assistantMode: "approved_faq" | "local_ai" = "approved_faq"
) {
  const current = await app.inject({
    method: "GET",
    url: tenantPath(tenantId, "config"),
    headers: headers(session, false)
  });
  expect(current.statusCode).toBe(200);
  const { tenant, config } = current.json<{ tenant: { displayName: string }; config: Record<string, unknown> & {
    businessName: string;
    segment: "pizzaria" | "barbearia" | "outro";
    greeting: string;
    handoffKeywords: string[];
    version: number;
  } }>();

  const saved = await app.inject({
    method: "PUT",
    url: tenantPath(tenantId, "config"),
    headers: headers(session),
    payload: {
      businessName: tenant.displayName,
      segment: config.segment,
      greeting: config.greeting,
      knowledge: [{ question: FAQ_QUESTION, answer: FAQ_ANSWER }],
      handoffKeywords: ["humano", "atendente"],
      assistantMode,
      version: config.version
    }
  });
  expect(saved.statusCode).toBe(200);
}

async function listConversations(app: BuiltApp, session: Session, tenantId: string) {
  const response = await app.inject({
    method: "GET",
    url: tenantPath(tenantId, "conversations"),
    headers: headers(session, false)
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ conversations: Conversation[] }>().conversations;
}

describe("local attendance session and tenant access", () => {
  it("does not register demo auth or tenant routes unless local demo is enabled", async () => {
    const app = await buildApp({ config: testConfig, store: new MemoryInboundEventStore(), logger: false });
    apps.push(app);

    const loginRoute = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {} });
    const tenantRoute = await app.inject({ method: "GET", url: "/api/v1/tenants" });
    const channelRoute = await app.inject({ method: "PUT", url: tenantPath(PIZZARIA, "channel"), payload: { phoneNumberId: "1234567890" } });
    expect(loginRoute.statusCode).toBe(404);
    expect(tenantRoute.statusCode).toBe(404);
    expect(channelRoute.statusCode).toBe(404);
  });

  it("rejects a production app when local demo is enabled, even if config parsing was bypassed", async () => {
    const unsafeConfig = { ...testConfig, nodeEnv: "production", localDemoEnabled: true } as AppConfig;
    await expect(buildApp({ config: unsafeConfig, store: new MemoryInboundEventStore(), logger: false }))
      .rejects.toThrow(/atendimento local exige ambiente não produtivo/);
  });

  it("rejects bad credentials, protects routes, validates CSRF, and invalidates a logged-out cookie", async () => {
    const { app } = await makeApp();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "pizzaria@atende.local", password: "wrong-password" }
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.headers["set-cookie"]).toBeUndefined();

    const privateResponse = await app.inject({ method: "GET", url: "/api/v1/tenants" });
    expect(privateResponse.statusCode).toBe(401);
    const privateTenantRoute = await app.inject({ method: "GET", url: tenantPath(PIZZARIA, "config") });
    expect(privateTenantRoute.statusCode).toBe(401);

    const admin = await login(app, "admin@atende.local");
    const noCsrf = await app.inject({
      method: "POST",
      url: tenantPath(PIZZARIA, "simulate"),
      headers: headers(admin, false),
      payload: { customerName: "Cliente", customerPhone: "5511990000001", text: "Oi" }
    });
    expect(noCsrf.statusCode).toBe(403);

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: headers(admin, false) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { id: "admin-demo", email: "admin@atende.local" }, csrfToken: admin.csrfToken });

    const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: headers(admin) });
    expect(logout.statusCode).toBe(204);
    const afterLogout = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: headers(admin, false) });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("limits attendants to their tenant and refuses conversation IDs replayed through another tenant", async () => {
    const { app } = await makeApp();
    const pizzaria = await login(app, "pizzaria@atende.local");
    const visibleTenants = await app.inject({ method: "GET", url: "/api/v1/tenants", headers: headers(pizzaria, false) });
    expect(visibleTenants.statusCode).toBe(200);
    expect(visibleTenants.json<{ tenants: Array<{ id: string }> }>().tenants.map((tenant) => tenant.id)).toEqual([PIZZARIA]);

    const otherConfig = await app.inject({ method: "GET", url: tenantPath(BARBEARIA, "config"), headers: headers(pizzaria, false) });
    expect(otherConfig.statusCode).toBe(403);
    const otherWrite = await simulate(app, pizzaria, BARBEARIA, "Oi", "5511990000002", "out-of-scope");
    expect(otherWrite.statusCode).toBe(403);

    const queued = await simulate(app, pizzaria, PIZZARIA, "Oi", "5511990000003", "pizza-only");
    expect(queued.statusCode).toBe(202);
    await processPending(app);
    const pizzaConversation = (await listConversations(app, pizzaria, PIZZARIA))[0]!;

    const admin = await login(app, "admin@atende.local");
    const replay = await getConversation(app, admin, BARBEARIA, pizzaConversation.id);
    expect(replay.statusCode).toBe(404);
    const replayAction = await app.inject({
      method: "POST",
      url: conversationPath(BARBEARIA, pizzaConversation.id, "close"),
      headers: headers(admin)
    });
    expect(replayAction.statusCode).toBe(404);
    expect((await getConversation(app, pizzaria, PIZZARIA, pizzaConversation.id)).json<{ conversation: Conversation }>().conversation.state).toBe("BOT_ACTIVE");
  });

  it("allows only platform admins to create tenants and uses config versions to reject stale writes", async () => {
    const { app } = await makeApp();
    const attendant = await login(app, "pizzaria@atende.local");
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/tenants",
      headers: headers(attendant),
      payload: { displayName: "Nova loja", segment: "outro" }
    });
    expect(denied.statusCode).toBe(403);

    const admin = await login(app, "admin@atende.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tenants",
      headers: headers(admin),
      payload: { displayName: "Café local", segment: "outro" }
    });
    expect(created.statusCode).toBe(201);
    const newTenantId = created.json<{ tenant: { id: string } }>().tenant.id;
    const accessible = await app.inject({ method: "GET", url: tenantPath(newTenantId, "config"), headers: headers(admin, false) });
    expect(accessible.statusCode).toBe(200);

    const current = await app.inject({ method: "GET", url: tenantPath(PIZZARIA, "config"), headers: headers(admin, false) });
    const { tenant, config } = current.json<{ tenant: { displayName: string }; config: {
      businessName: string;
      segment: "pizzaria" | "barbearia" | "outro";
      greeting: string;
      knowledge: Array<{ question: string; answer: string }>;
      handoffKeywords: string[];
      version: number;
    } }>();
    const payload = {
      businessName: "Pizzaria versão atualizada",
      segment: config.segment,
      greeting: config.greeting,
      knowledge: config.knowledge,
      handoffKeywords: config.handoffKeywords,
      version: config.version
    };
    const saved = await app.inject({
      method: "PUT",
      url: tenantPath(PIZZARIA, "config"),
      headers: headers(admin),
      payload
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ config: { version: number } }>().config.version).toBe(config.version + 1);

    const stale = await app.inject({
      method: "PUT",
      url: tenantPath(PIZZARIA, "config"),
      headers: headers(admin),
      payload: { ...payload, businessName: "Sobrescrita obsoleta" }
    });
    expect(stale.statusCode).toBe(409);
    const afterConflict = await app.inject({ method: "GET", url: tenantPath(PIZZARIA, "config"), headers: headers(admin, false) });
    expect(afterConflict.json<{ config: { businessName: string } }>().config.businessName).toBe("Pizzaria versão atualizada");

    const attendantWrite = await app.inject({
      method: "PUT",
      url: tenantPath(PIZZARIA, "config"),
      headers: headers(attendant),
      payload: { ...payload, version: payload.version + 1 }
    });
    expect(attendantWrite.statusCode).toBe(403);
    expect(tenant.displayName).toBe("Pizzaria Demo");
  });

  it("binds a strict numeric test channel only for CSRF-authenticated platform admins", async () => {
    const { app } = await makeApp();
    const admin = await login(app, "admin@atende.local");
    const attendant = await login(app, "pizzaria@atende.local");
    const url = tenantPath(PIZZARIA, "channel");

    const denied = await app.inject({
      method: "PUT",
      url,
      headers: headers(attendant),
      payload: { phoneNumberId: "1234567890" }
    });
    expect(denied.statusCode).toBe(403);

    const missingCsrf = await app.inject({
      method: "PUT",
      url,
      headers: headers(admin, false),
      payload: { phoneNumberId: "1234567890" }
    });
    expect(missingCsrf.statusCode).toBe(403);

    for (const phoneNumberId of ["0", "012345", "x123", "1".repeat(33)]) {
      const invalid = await app.inject({
        method: "PUT",
        url,
        headers: headers(admin),
        payload: { phoneNumberId }
      });
      expect(invalid.statusCode).toBe(400);
    }
    const extraField = await app.inject({
      method: "PUT",
      url,
      headers: headers(admin),
      payload: { phoneNumberId: "1234567890", tenantId: BARBEARIA }
    });
    expect(extraField.statusCode).toBe(400);

    const missingTenant = await app.inject({
      method: "PUT",
      url: tenantPath("missing-tenant", "channel"),
      headers: headers(admin),
      payload: { phoneNumberId: "1234567890" }
    });
    expect(missingTenant.statusCode).toBe(404);

    const bound = await app.inject({
      method: "PUT",
      url,
      headers: headers(admin),
      payload: { phoneNumberId: "1234567890" }
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json<{ tenant: { id: string; channelPhoneNumberId: string } }>().tenant).toMatchObject({
      id: PIZZARIA,
      channelPhoneNumberId: "1234567890"
    });

    const repeated = await app.inject({
      method: "PUT",
      url,
      headers: headers(admin),
      payload: { phoneNumberId: "1234567890" }
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json<{ tenant: { channelPhoneNumberId: string } }>().tenant.channelPhoneNumberId).toBe("1234567890");

    const duplicate = await app.inject({
      method: "PUT",
      url: tenantPath(BARBEARIA, "channel"),
      headers: headers(admin),
      payload: { phoneNumberId: "1234567890" }
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it("routes signed test-number webhooks to the bound tenant and ignores tenant_id fields", async () => {
    const { app } = await makeApp();
    const admin = await login(app, "admin@atende.local");
    const phoneNumberId = "987654321012345678";
    const bind = await app.inject({
      method: "PUT",
      url: tenantPath(PIZZARIA, "channel"),
      headers: headers(admin),
      payload: { phoneNumberId }
    });
    expect(bind.statusCode).toBe(200);

    const webhook = await postSignedWebhook(app, {
      object: "whatsapp_business_account",
      tenant_id: BARBEARIA,
      entry: [{ changes: [{ value: {
        tenant_id: BARBEARIA,
        metadata: { phone_number_id: phoneNumberId },
        contacts: [{ wa_id: "5511991000999", profile: { name: "Bound test customer" } }],
        messages: [{
          id: "wamid.bound-test-channel",
          from: "5511991000999",
          timestamp: "1791028800",
          type: "text",
          text: { body: "Mensagem recebida no número de teste" },
          tenant_id: BARBEARIA
        }]
      } }] }]
    });
    expect(webhook.statusCode).toBe(200);
    expect(webhook.headers["x-webhook-enqueued"]).toBe("1");

    await processPending(app);
    const pizzaConversations = await listConversations(app, admin, PIZZARIA);
    const barberConversations = await listConversations(app, admin, BARBEARIA);
    expect(pizzaConversations).toHaveLength(1);
    expect(pizzaConversations[0]).toMatchObject({ tenantId: PIZZARIA, customerPhone: "5511991000999" });
    expect(barberConversations).toHaveLength(0);
  });
});

describe("local attendance queue and conversation lifecycle", () => {
  it("deduplicates a client event and replies from the configured FAQ as SIMULATED", async () => {
    const { app } = await makeApp();
    const admin = await login(app, "admin@atende.local");
    await configureFaq(app, admin);
    const attendant = await login(app, "pizzaria@atende.local");

    const first = await simulate(app, attendant, PIZZARIA, FAQ_QUESTION, "5511991000001", "faq-event");
    const duplicate = await simulate(app, attendant, PIZZARIA, FAQ_QUESTION, "5511991000001", "faq-event");
    expect(first.statusCode).toBe(202);
    expect(first.json<{ status: string }>().status).toBe("PENDING");
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json<{ status: string }>().status).toBe("DUPLICATE");

    await processPending(app);
    const [conversation] = await listConversations(app, attendant, PIZZARIA);
    expect(conversation?.state).toBe("BOT_ACTIVE");
    const detail = await getConversation(app, attendant, PIZZARIA, conversation!.id);
    expect(detail.statusCode).toBe(200);
    const messages = detail.json<{ messages: Message[] }>().messages;
    expect(messages.filter((message) => message.role === "CUSTOMER")).toHaveLength(1);
    expect(messages.find((message) => message.role === "BOT")).toMatchObject({ text: FAQ_ANSWER, deliveryStatus: "SIMULATED" });
  });

  it("moves an unanswered greeting conversation to WAITING_HUMAN on an explicit handoff", async () => {
    const { app } = await makeApp();
    const attendant = await login(app, "pizzaria@atende.local");
    const accepted = await simulate(app, attendant, PIZZARIA, "Oi", "5511991000006", "greeting-before-handoff");
    expect(accepted.statusCode).toBe(202);
    await processPending(app);
    const [conversation] = await listConversations(app, attendant, PIZZARIA);
    expect(conversation?.state).toBe("BOT_ACTIVE");

    const handoff = await app.inject({
      method: "POST",
      url: conversationPath(PIZZARIA, conversation!.id, "handoff"),
      headers: headers(attendant)
    });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json<{ conversation: Conversation }>().conversation.state).toBe("WAITING_HUMAN");
  });

  it("falls back to a human, keeps the bot silent, supports human actions, and reopens a closed conversation", async () => {
    const { app } = await makeApp();
    const admin = await login(app, "admin@atende.local");
    await configureFaq(app, admin);
    const attendant = await login(app, "pizzaria@atende.local");

    await simulate(app, attendant, PIZZARIA, "Vocês aceitam vale-refeição?", "5511991000002", "unknown-1");
    await processPending(app);
    let [conversation] = await listConversations(app, attendant, PIZZARIA);
    expect(conversation?.state).toBe("WAITING_HUMAN");

    const claim = await app.inject({
      method: "POST",
      url: conversationPath(PIZZARIA, conversation!.id, "claim"),
      headers: headers(attendant)
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json<{ conversation: Conversation }>().conversation).toMatchObject({ state: "HUMAN_ACTIVE", assignedUserId: "pizzaria-user" });

    await simulate(app, attendant, PIZZARIA, "E também aceitam cartão?", "5511991000002", "human-follow-up");
    await processPending(app);
    let detail = await getConversation(app, attendant, PIZZARIA, conversation!.id);
    let messages = detail.json<{ messages: Message[] }>().messages;
    expect(messages.filter((message) => message.role === "BOT")).toHaveLength(0);
    expect((await listConversations(app, attendant, PIZZARIA))[0]?.state).toBe("HUMAN_ACTIVE");

    const reply = await app.inject({
      method: "POST",
      url: conversationPath(PIZZARIA, conversation!.id, "reply"),
      headers: headers(attendant),
      payload: { text: "Vou confirmar com a equipe e retorno por aqui." }
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json<{ message: Message }>().message).toMatchObject({ role: "ATTENDANT", deliveryStatus: "SIMULATED" });

    const resumed = await app.inject({
      method: "POST",
      url: conversationPath(PIZZARIA, conversation!.id, "resume"),
      headers: headers(attendant)
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<{ conversation: Conversation }>().conversation.state).toBe("BOT_ACTIVE");

    await simulate(app, attendant, PIZZARIA, "Quero falar com um atendente humano.", "5511991000002", "handoff-again");
    await processPending(app);
    conversation = (await listConversations(app, attendant, PIZZARIA))[0]!;
    expect(conversation.state).toBe("WAITING_HUMAN");
    const secondClaim = await app.inject({
      method: "POST",
      url: conversationPath(PIZZARIA, conversation.id, "claim"),
      headers: headers(attendant)
    });
    expect(secondClaim.statusCode).toBe(200);
    const closed = await app.inject({
      method: "POST",
      url: conversationPath(PIZZARIA, conversation.id, "close"),
      headers: headers(attendant)
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json<{ conversation: Conversation }>().conversation.state).toBe("CLOSED");

    await simulate(app, attendant, PIZZARIA, FAQ_QUESTION, "5511991000002", "reopen-after-close");
    await processPending(app);
    const reopened = (await listConversations(app, attendant, PIZZARIA))[0]!;
    expect(reopened.id).toBe(conversation.id);
    expect(reopened.state).toBe("BOT_ACTIVE");
    detail = await getConversation(app, attendant, PIZZARIA, conversation.id);
    messages = detail.json<{ messages: Message[] }>().messages;
    expect(messages.at(-1)).toMatchObject({ role: "BOT", text: FAQ_ANSWER, deliveryStatus: "SIMULATED" });
  });

  it("keeps the same caller message ID isolated across tenants", async () => {
    const { app } = await makeApp();
    const admin = await login(app, "admin@atende.local");
    const sharedPhone = "5511991000003";

    const pizzaEvent = await simulate(app, admin, PIZZARIA, "Pergunta da pizzaria", sharedPhone, "same-client-id");
    const barberEvent = await simulate(app, admin, BARBEARIA, "Pergunta da barbearia", sharedPhone, "same-client-id");
    expect(pizzaEvent.statusCode).toBe(202);
    expect(barberEvent.statusCode).toBe(202);
    expect(pizzaEvent.json<{ status: string }>().status).toBe("PENDING");
    expect(barberEvent.json<{ status: string }>().status).toBe("PENDING");
    expect(pizzaEvent.json<{ eventId: string }>().eventId).not.toBe(barberEvent.json<{ eventId: string }>().eventId);

    await processPending(app);
    const pizzaConversation = (await listConversations(app, admin, PIZZARIA))[0]!;
    const barberConversation = (await listConversations(app, admin, BARBEARIA))[0]!;
    expect(pizzaConversation.id).not.toBe(barberConversation.id);
    expect(pizzaConversation.tenantId).toBe(PIZZARIA);
    expect(barberConversation.tenantId).toBe(BARBEARIA);
    expect((await getConversation(app, admin, BARBEARIA, pizzaConversation.id)).statusCode).toBe(404);
  });

  it("lets only one of two concurrent claimants own a waiting conversation", async () => {
    const { app } = await makeApp();
    const admin = await login(app, "admin@atende.local");
    const attendant = await login(app, "pizzaria@atende.local");
    await simulate(app, attendant, PIZZARIA, "Preciso de ajuda com uma pessoa.", "5511991000004", "claim-race");
    await processPending(app);
    const [conversation] = await listConversations(app, attendant, PIZZARIA);
    expect(conversation?.state).toBe("WAITING_HUMAN");

    const attempts = await Promise.all([
      app.inject({ method: "POST", url: conversationPath(PIZZARIA, conversation!.id, "claim"), headers: headers(attendant) }),
      app.inject({ method: "POST", url: conversationPath(PIZZARIA, conversation!.id, "claim"), headers: headers(admin) })
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const assigned = (await getConversation(app, admin, PIZZARIA, conversation!.id)).json<{ conversation: Conversation }>().conversation;
    expect(assigned.state).toBe("HUMAN_ACTIVE");
    const winner = attempts[0]?.statusCode === 200 ? attendant : admin;
    expect(assigned.assignedUserId).toBe(winner.user.id);
    const loser = winner === attendant ? admin : attendant;
    const rejectedReply = await app.inject({
      method: "POST",
      url: conversationPath(PIZZARIA, conversation!.id, "reply"),
      headers: headers(loser),
      payload: { text: "Não devo tomar esta conversa." }
    });
    expect(rejectedReply.statusCode).toBe(409);
  });

  it("routes a signed webhook by registered channel and ignores an untrusted tenant_id", async () => {
    const { app } = await makeApp();
    const admin = await login(app, "admin@atende.local");
    const payload = {
      object: "whatsapp_business_account",
      tenant_id: BARBEARIA,
      entry: [{ changes: [{ value: {
        tenant_id: BARBEARIA,
        metadata: { phone_number_id: "demo-pizzaria-phone" },
        contacts: [{ wa_id: "5511991000005", profile: { name: "Webhook customer" } }],
        messages: [{
          id: "wamid.local-demo-1",
          from: "5511991000005",
          timestamp: "1791028800",
          type: "text",
          text: { body: "Mensagem recebida pelo canal da pizzaria" },
          tenant_id: BARBEARIA
        }]
      } }] }]
    };
    const response = await postSignedWebhook(app, payload);
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-webhook-enqueued"]).toBe("1");

    await processPending(app);
    const pizzaConversations = await listConversations(app, admin, PIZZARIA);
    const barberConversations = await listConversations(app, admin, BARBEARIA);
    expect(pizzaConversations).toHaveLength(1);
    expect(pizzaConversations[0]).toMatchObject({ tenantId: PIZZARIA, customerPhone: "5511991000005" });
    expect(barberConversations).toHaveLength(0);
  });

  it("discards signed events from unknown channels and hands valid-channel media to a person", async () => {
    const { app } = await makeApp();
    const unknownChannel = await postSignedWebhook(app, {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "unregistered-channel" },
        contacts: [{ wa_id: "5511991000007", profile: { name: "Unknown channel" } }],
        messages: [{ id: "wamid.unknown-channel", from: "5511991000007", timestamp: "1791028800", type: "text", text: { body: FAQ_QUESTION } }]
      } }] }]
    });
    expect(unknownChannel.statusCode).toBe(200);
    expect(unknownChannel.headers["x-webhook-enqueued"]).toBe("1");

    const mediaEvent = await postSignedWebhook(app, {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "demo-barbearia-phone" },
        contacts: [{ wa_id: "5511991000008", profile: { name: "Media customer" } }],
        messages: [{ id: "wamid.valid-media", from: "5511991000008", timestamp: "1791028801", type: "image", image: { id: "media-1" } }]
      } }] }]
    });
    expect(mediaEvent.statusCode).toBe(200);
    expect(mediaEvent.headers["x-webhook-enqueued"]).toBe("1");

    await processPending(app);
    const admin = await login(app, "admin@atende.local");
    expect(await listConversations(app, admin, PIZZARIA)).toHaveLength(0);
    const barberConversations = await listConversations(app, admin, BARBEARIA);
    expect(barberConversations).toHaveLength(1);
    expect(barberConversations[0]).toMatchObject({ tenantId: BARBEARIA, customerPhone: "5511991000008", state: "WAITING_HUMAN" });
  });
});

describe("tenant-configured local AI answer selection", () => {
  it("uses the local classifier only to select a tenant-approved answer", async () => {
    const selector: KnowledgeAnswerSelector = {
      selectAnswerIndex: vi.fn().mockResolvedValue(0)
    };
    const { app } = await makeApp({ localAiEnabled: true, knowledgeAnswerSelector: selector });
    const admin = await login(app, "admin@atende.local");
    await configureFaq(app, admin, PIZZARIA, "local_ai");
    const systemInfo = await app.inject({ url: "/api/v1/system/info" });
    expect(systemInfo.json()).toMatchObject({
      localAiEnabled: true,
      capabilities: expect.arrayContaining(["assistant.local.knowledge-classification"])
    });

    const accepted = await simulate(app, admin, PIZZARIA, "Vocês atendem até que horas?", "5511991000311", "local-ai-faq");
    expect(accepted.statusCode).toBe(202);
    await processPending(app);
    const conversation = (await listConversations(app, admin, PIZZARIA))[0]!;
    const detail = await getConversation(app, admin, PIZZARIA, conversation.id);
    expect(detail.json<{ conversation: Conversation; messages: Message[] }>().messages.map((message) => message.text)).toEqual([
      "Vocês atendem até que horas?",
      FAQ_ANSWER
    ]);
    expect(selector.selectAnswerIndex).toHaveBeenCalledWith(expect.objectContaining({
      businessName: "Pizzaria Demo",
      customerText: "Vocês atendem até que horas?",
      knowledge: [{ question: FAQ_QUESTION, answer: FAQ_ANSWER }]
    }));
    expect(detail.json<{ messages: Message[] }>().messages[1]?.deliveryStatus).toBe("SIMULATED");
  });

  it("fails closed to a human when local AI is not configured", async () => {
    const { app } = await makeApp();
    const admin = await login(app, "admin@atende.local");
    await configureFaq(app, admin, PIZZARIA, "local_ai");
    const accepted = await simulate(app, admin, PIZZARIA, "Vocês atendem até que horas?", "5511991000312", "local-ai-unavailable");
    expect(accepted.statusCode).toBe(202);
    await processPending(app);
    const conversation = (await listConversations(app, admin, PIZZARIA))[0]!;
    expect(conversation.state).toBe("WAITING_HUMAN");
    expect((await getConversation(app, admin, PIZZARIA, conversation.id)).json<{ messages: Message[] }>().messages).toHaveLength(1);
  });

  it("does not invoke local AI when the customer asks for a person", async () => {
    const selector: KnowledgeAnswerSelector = { selectAnswerIndex: vi.fn().mockResolvedValue(0) };
    const { app } = await makeApp({ localAiEnabled: true, knowledgeAnswerSelector: selector });
    const admin = await login(app, "admin@atende.local");
    await configureFaq(app, admin, PIZZARIA, "local_ai");
    await simulate(app, admin, PIZZARIA, "Quero falar com atendente", "5511991000313", "local-ai-handoff");
    await processPending(app);
    expect(selector.selectAnswerIndex).not.toHaveBeenCalled();
  });

  it("routes order, reservation and appointment actions to a person before local AI can choose a nearby FAQ", async () => {
    const selector: KnowledgeAnswerSelector = { selectAnswerIndex: vi.fn().mockResolvedValue(0) };
    const { app } = await makeApp({ localAiEnabled: true, knowledgeAnswerSelector: selector });
    const admin = await login(app, "admin@atende.local");
    await configureFaq(app, admin, PIZZARIA, "local_ai");
    await configureFaq(app, admin, BARBEARIA, "local_ai");

    const scenarios = [
      { tenantId: PIZZARIA, text: "Quero fazer um pedido para entrega, por favor.", phone: "5511991000320", messageId: "local-ai-order-action" },
      { tenantId: PIZZARIA, text: "Vocês aceitam pedido para retirada?", phone: "5511991000323", messageId: "local-ai-pickup-order-action" },
      { tenantId: PIZZARIA, text: "Quero reservar uma mesa para oito pessoas hoje às 20h.", phone: "5511991000321", messageId: "local-ai-reservation-action" },
      { tenantId: PIZZARIA, text: "Tem mesa para duas pessoas hoje à noite?", phone: "5511991000324", messageId: "local-ai-table-availability-action" },
      { tenantId: BARBEARIA, text: "Gostaria de agendar um horário para corte amanhã.", phone: "5511991000322", messageId: "local-ai-appointment-action" },
      { tenantId: BARBEARIA, text: "Vocês têm algum horário disponível para amanhã?", phone: "5511991000325", messageId: "local-ai-available-appointment-action" },
      { tenantId: BARBEARIA, text: "Consegue me encaixar para fazer a barba?", phone: "5511991000326", messageId: "local-ai-barber-fit-in-action" },
      { tenantId: BARBEARIA, text: "Queria um horário para cortar o cabelo na sexta.", phone: "5511991000327", messageId: "local-ai-haircut-time-action" },
      { tenantId: BARBEARIA, text: "Vocês fazem orçamento para um evento?", phone: "5511991000328", messageId: "local-ai-quote-action" }
    ];

    for (const scenario of scenarios) {
      const accepted = await simulate(app, admin, scenario.tenantId, scenario.text, scenario.phone, scenario.messageId);
      expect(accepted.statusCode).toBe(202);
      await processPending(app);

      const conversation = (await listConversations(app, admin, scenario.tenantId))
        .find((item) => item.customerPhone === scenario.phone);
      expect(conversation?.state).toBe("WAITING_HUMAN");
      const detail = await getConversation(app, admin, scenario.tenantId, conversation!.id);
      expect(detail.json<{ messages: Message[] }>().messages.map((message) => message.role)).toEqual(["CUSTOMER"]);
    }

    expect(selector.selectAnswerIndex).not.toHaveBeenCalled();
  });

  it("keeps ordinary business-hours questions eligible for the approved FAQ classifier", async () => {
    const selector: KnowledgeAnswerSelector = { selectAnswerIndex: vi.fn().mockResolvedValue(0) };
    const { app } = await makeApp({ localAiEnabled: true, knowledgeAnswerSelector: selector });
    const admin = await login(app, "admin@atende.local");
    await configureFaq(app, admin, PIZZARIA, "local_ai");

    await simulate(app, admin, PIZZARIA, "Vocês têm horário de atendimento aos sábados?", "5511991000329", "local-ai-hours-question");
    await processPending(app);

    const conversation = (await listConversations(app, admin, PIZZARIA))[0]!;
    expect(conversation.state).toBe("BOT_ACTIVE");
    expect(selector.selectAnswerIndex).toHaveBeenCalledTimes(1);
    const detail = await getConversation(app, admin, PIZZARIA, conversation.id);
    expect(detail.json<{ messages: Message[] }>().messages.map((message) => message.text)).toEqual([
      "Vocês têm horário de atendimento aos sábados?",
      FAQ_ANSWER
    ]);
  });
});
