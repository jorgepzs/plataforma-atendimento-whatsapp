import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { createMetaSignature } from "../src/meta/signature.js";
import type { InboundEventStore } from "../src/ports/inbound-event-store.js";
import { TestEventStore, testConfig, webhookPayload } from "./helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

type BuiltApp = Awaited<ReturnType<typeof buildApp>>;

async function makeApp(): Promise<{ app: BuiltApp; store: TestEventStore }>;
async function makeApp<TStore extends InboundEventStore>(
  store: TStore,
  config?: AppConfig
): Promise<{ app: BuiltApp; store: TStore }>;
async function makeApp(
  store: InboundEventStore = new TestEventStore(),
  config: AppConfig = testConfig
) {
  const app = await buildApp({ config, store, logger: false });
  apps.push(app);
  return { app, store };
}

describe("health endpoints", () => {
  it("reports liveness and readiness", async () => {
    const { app, store } = await makeApp();
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", dependencies: { eventStore: { status: "up", kind: "memory" } } });
    store.ready = false;
    const down = await app.inject({ method: "GET", url: "/health/ready" });
    expect(down.statusCode).toBe(503);
    expect(down.json().status).toBe("not_ready");
  });
});

describe("Meta webhook", () => {
  it("verifies GET challenge and rejects incorrect verification", async () => {
    const { app } = await makeApp();
    const accepted = await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=challenge-123" });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["content-type"]).toContain("text/plain");
    expect(accepted.body).toBe("challenge-123");
    const rejected = await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x" });
    expect(rejected.statusCode).toBe(403);
  });

  it("accepts a correctly signed raw request body", async () => {
    const { app, store } = await makeApp();
    const body = JSON.stringify(webhookPayload());
    const signature = createMetaSignature(Buffer.from(body), "app-secret");
    const response = await app.inject({ method: "POST", url: "/webhooks/meta", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(response.headers["x-webhook-enqueued"]).toBe("1");
    expect(response.headers["x-webhook-duplicates"]).toBe("0");
    expect(store.messages).toHaveLength(1);
  });

  it("rejects a signed message without phone_number_id instead of acknowledging and dropping it", async () => {
    const { app, store } = await makeApp();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {
        messages: [{ id: "wamid.no-channel", from: "15551234567", timestamp: "1700000000", type: "text", text: { body: "hello" } }]
      } }] }]
    });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": createMetaSignature(Buffer.from(body), "app-secret") },
      payload: body
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_payload" });
    expect(store.messages).toHaveLength(0);
  });

  it("acknowledges signed empty and status-only callbacks without enqueuing inbound events", async () => {
    const { app, store } = await makeApp();
    const payloads = [
      { object: "whatsapp_business_account", entry: [] },
      { object: "whatsapp_business_account", entry: [{ changes: [{ value: {
        statuses: [{ id: "wamid.outbound-no-metadata", status: "delivered" }]
      } }] }] },
      { object: "whatsapp_business_account", entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "phone-1" },
        statuses: [{ id: "wamid.outbound", status: "delivered" }]
      } }] }] }
    ];

    for (const payload of payloads) {
      const body = JSON.stringify(payload);
      const response = await app.inject({
        method: "POST",
        url: "/webhooks/meta",
        headers: { "content-type": "application/json", "x-hub-signature-256": createMetaSignature(Buffer.from(body), "app-secret") },
        payload: body
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-webhook-normalized"]).toBe("0");
      expect(response.headers["x-webhook-enqueued"]).toBe("0");
    }

    expect(store.messages).toHaveLength(0);
  });

  it("rejects a mixed batch atomically when one message change has no phone_number_id", async () => {
    const { app, store } = await makeApp();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [
        { value: { metadata: { phone_number_id: "phone-valid" }, messages: [
          { id: "wamid.valid", from: "15550000001", timestamp: "1700000000", type: "text", text: { body: "valid" } }
        ] } },
        { value: { messages: [
          { id: "wamid.missing-channel", from: "15550000002", timestamp: "1700000001", type: "text", text: { body: "invalid" } }
        ] } }
      ] }]
    });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": createMetaSignature(Buffer.from(body), "app-secret") },
      payload: body
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_payload" });
    expect(store.messages).toHaveLength(0);
  });

  it("enqueues all messages in one signed batch while retaining each channel ID", async () => {
    const { app, store } = await makeApp();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [
        { value: { metadata: { phone_number_id: "phone-a" }, messages: [
          { id: "wamid.a", from: "15550000001", timestamp: "1700000000", type: "text", text: { body: "A" } }
        ] } },
        { value: { metadata: { phone_number_id: "phone-b" }, messages: [
          { id: "wamid.b", from: "15550000002", timestamp: "1700000001", type: "text", text: { body: "B" } }
        ] } }
      ] }]
    });
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": createMetaSignature(Buffer.from(body), "app-secret") },
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-webhook-normalized"]).toBe("2");
    expect(response.headers["x-webhook-enqueued"]).toBe("2");
    expect(store.messages.map(({ providerEventId, providerPhoneNumberId }) => ({ providerEventId, providerPhoneNumberId }))).toEqual([
      { providerEventId: "wamid.a", providerPhoneNumberId: "phone-a" },
      { providerEventId: "wamid.b", providerPhoneNumberId: "phone-b" }
    ]);
  });

  it.each(["sha256=invalid", undefined])("rejects invalid or missing signature (%s)", async (signature) => {
    const { app, store } = await makeApp();
    const response = await app.inject({ method: "POST", url: "/webhooks/meta", headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) }, payload: webhookPayload() });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_webhook_signature" });
    expect(store.messages).toHaveLength(0);
  });

  it("deduplicates repeated event IDs", async () => {
    const store = new MemoryInboundEventStore();
    const { app } = await makeApp(store);
    const body = JSON.stringify(webhookPayload());
    const headers = { "content-type": "application/json", "x-hub-signature-256": createMetaSignature(Buffer.from(body), "app-secret") };
    const first = await app.inject({ method: "POST", url: "/webhooks/meta", headers, payload: body });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-webhook-enqueued"]).toBe("1");
    expect(first.headers["x-webhook-duplicates"]).toBe("0");

    const repeated = await app.inject({ method: "POST", url: "/webhooks/meta", headers, payload: body });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.headers["x-webhook-enqueued"]).toBe("0");
    expect(repeated.headers["x-webhook-duplicates"]).toBe("1");
    expect(store.messages).toHaveLength(1);
  });

  it("does not expose processing diagnostics in production", async () => {
    const config: AppConfig = { ...testConfig, nodeEnv: "production", databaseUrl: "postgresql://unused" };
    const { app } = await makeApp(new TestEventStore(), config);
    const body = JSON.stringify(webhookPayload());
    const signature = createMetaSignature(Buffer.from(body), "app-secret");
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-webhook-enqueued"]).toBeUndefined();
    expect(response.headers["x-webhook-duplicates"]).toBeUndefined();
  });

  it("returns service unavailable when signatures are required without an app secret", async () => {
    const config = { ...testConfig, metaAppSecret: undefined } as unknown as typeof testConfig;
    const { app } = await makeApp(new TestEventStore(), config);
    const response = await app.inject({ method: "POST", url: "/webhooks/meta", payload: webhookPayload() });
    expect(response.statusCode).toBe(503);
  });
});
