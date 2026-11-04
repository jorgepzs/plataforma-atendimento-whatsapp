import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildWebhookGateway } from "../src/infra/meta/webhook-gateway.js";
import { createMetaSignature } from "../src/meta/signature.js";

const APP_SECRET = "0123456789abcdef0123456789abcdef";
const VERIFY_TOKEN = "meta-verify-token-123";
const LOCAL_UPSTREAM_SECRET = "local-upstream-secret-0123456789abcdef";
const UPSTREAM_URL = "http://127.0.0.1:3000/webhooks/meta";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

type TransportCall = { input: RequestInfo | URL; init?: RequestInit };
type Responder = (call: TransportCall) => Promise<Response>;

async function makeGateway(responder: Responder = async () => validUpstreamResponse()) {
  const calls: TransportCall[] = [];
  const fetchTransport: typeof fetch = async (input, init) => {
    const call: TransportCall = { input, ...(init ? { init } : {}) };
    calls.push(call);
    return responder(call);
  };
  const app = await buildWebhookGateway({
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    localUpstreamSecret: LOCAL_UPSTREAM_SECRET,
    fetchTransport
  });
  apps.push(app);
  return { app, calls };
}

function validUpstreamResponse(overrides: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
} = {}): Response {
  return new Response(overrides.body ?? '{"received":true}', {
    status: overrides.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-webhook-normalized": "1",
      "x-webhook-enqueued": "1",
      "x-webhook-duplicates": "0",
      "x-webhook-unknown-channels": "0",
      ...overrides.headers
    }
  });
}

function signedHeaders(body: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-hub-signature-256": createMetaSignature(Buffer.from(body), APP_SECRET),
    ...extra
  };
}

describe("dedicated Meta webhook gateway", () => {
  it("rejects absent, weak, placeholder, and malformed secret configuration generically", async () => {
    const valid = {
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      localUpstreamSecret: LOCAL_UPSTREAM_SECRET
    };
    const badConfigurations = [
      { ...valid, appSecret: "" },
      { ...valid, appSecret: "placeholder" },
      { ...valid, verifyToken: "change-me" },
      { ...valid, localUpstreamSecret: "short-secret" },
      { ...valid, localUpstreamSecret: "test-local-upstream-secret-0123456" },
      { ...valid, localUpstreamSecret: APP_SECRET }
    ];

    for (const config of badConfigurations) {
      await expect(buildWebhookGateway(config)).rejects.toThrow("Webhook gateway configuration is invalid.");
    }
  });

  it("permits only the known development upstream signing secret while requiring a real Meta secret", async () => {
    const app = await buildWebhookGateway({
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      localUpstreamSecret: "dev-app-secret",
      fetchTransport: async () => validUpstreamResponse()
    });
    apps.push(app);
    expect(app).toBeDefined();
    await expect(buildWebhookGateway({
      appSecret: "dev-app-secret",
      verifyToken: VERIFY_TOKEN,
      localUpstreamSecret: "another-local-upstream-secret-012345"
    })).rejects.toThrow("Webhook gateway configuration is invalid.");
  });

  it("serves only the exact webhook route and explicitly refuses HEAD", async () => {
    const { app, calls } = await makeGateway();
    const paths = ["/api/v1/anything", "/health/ready", "/files/a", "/webhooks/meta/", "/webhooks%2Fmeta"];

    for (const url of paths) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "HEAD", url: "/webhooks/meta" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/anything" })).statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("answers a strict, bounded verification challenge locally without forwarding it", async () => {
    const { app, calls } = await makeGateway();
    const accepted = await app.inject({
      method: "GET",
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-123`
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["content-type"]).toContain("text/plain");
    expect(accepted.body).toBe("challenge-123");
    const acceptedWithExtra = await app.inject({
      method: "GET",
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=extra-challenge&hub.extra=metadata`
    });
    expect(acceptedWithExtra.statusCode).toBe(200);
    expect(acceptedWithExtra.body).toBe("extra-challenge");

    const invalidUrls = [
      `/webhooks/meta?hub.mode=subscribe&hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`,
      `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.verify_token=wrong&hub.challenge=x`,
      `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`,
      `/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`,
      `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${"x".repeat(1_025)}`
    ];
    for (const url of invalidUrls) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("validates Meta HMAC before forwarding exact bytes to the fixed local API", async () => {
    const { app, calls } = await makeGateway();
    const body = '{ "object" : "whatsapp_business_account", "entry" : [] }\n';
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: {
        ...signedHeaders(body, {
          cookie: "session=private",
          authorization: "Bearer private",
          "x-forwarded-for": "203.0.113.10",
          origin: "https://untrusted.example"
        })
      },
      payload: Buffer.from(body)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(response.headers["x-webhook-enqueued"]).toBeUndefined();
    expect(calls).toHaveLength(1);

    const call = calls[0];
    expect(call?.input).toBe(UPSTREAM_URL);
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.redirect).toBe("error");
    expect(Buffer.from(call?.init?.body as Uint8Array)).toEqual(Buffer.from(body));
    expect(call?.init?.headers).toEqual({
      "content-type": "application/json",
      "x-hub-signature-256": createMetaSignature(Buffer.from(body), LOCAL_UPSTREAM_SECRET)
    });
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "sha256=not-a-digest"],
    ["incorrect", `sha256=${"0".repeat(64)}`]
  ])("does not call upstream for a %s signature", async (_label, signature) => {
    const { app, calls } = await makeGateway();
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const headers = signedHeaders(body);
    if (signature === undefined) delete headers["x-hub-signature-256"];
    else headers["x-hub-signature-256"] = signature;

    const response = await app.inject({ method: "POST", url: "/webhooks/meta", headers, payload: Buffer.from(body) });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_webhook_signature" });
    expect(calls).toHaveLength(0);
  });

  it("rejects query strings, unsupported media types, and malformed JSON before forwarding", async () => {
    const { app, calls } = await makeGateway();
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const withQuery = await app.inject({
      method: "POST",
      url: "/webhooks/meta?x=1",
      headers: signedHeaders(body),
      payload: Buffer.from(body)
    });
    expect(withQuery.statusCode).toBe(400);

    const wrongType = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: { ...signedHeaders(body), "content-type": "text/plain" },
      payload: Buffer.from(body)
    });
    expect(wrongType.statusCode).toBe(415);

    const malformedBody = "{";
    const malformed = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: signedHeaders(malformedBody),
      payload: Buffer.from(malformedBody)
    });
    expect(malformed.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("caps inbound bodies at two MiB", async () => {
    const { app, calls } = await makeGateway();
    const body = `{"payload":"${"x".repeat(2 * 1024 * 1024)}"}`;
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: signedHeaders(body),
      payload: Buffer.from(body)
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "request_too_large" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["non-success status", () => validUpstreamResponse({ status: 500, body: "sensitive upstream detail" }), 502, "webhook_upstream_unavailable"],
    ["redirect response", () => validUpstreamResponse({ status: 302, body: "" , headers: { location: "https://untrusted.example/" } }), 502, "webhook_upstream_unavailable"],
    ["malformed response JSON", () => validUpstreamResponse({ body: "not-json" }), 502, "webhook_upstream_unavailable"],
    ["unexpected response object", () => validUpstreamResponse({ body: '{"received":false,"detail":"secret"}' }), 502, "webhook_upstream_unavailable"],
    ["missing summary count", () => validUpstreamResponse({ headers: { "x-webhook-enqueued": "" } }), 502, "webhook_upstream_unavailable"],
    ["malformed summary count", () => validUpstreamResponse({ headers: { "x-webhook-enqueued": "1,2" } }), 502, "webhook_upstream_unavailable"],
    ["unmapped channel", () => validUpstreamResponse({ headers: {
      "x-webhook-enqueued": "0",
      "x-webhook-duplicates": "0",
      "x-webhook-unknown-channels": "1"
    } }), 503, "webhook_channel_unmapped"]
  ])("does not acknowledge an upstream %s", async (_label, responseFactory, expectedStatus, expectedError) => {
    const { app } = await makeGateway(async () => responseFactory());
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/meta",
      headers: signedHeaders(body),
      payload: Buffer.from(body)
    });

    expect(response.statusCode).toBe(expectedStatus);
    expect(response.json()).toEqual({ error: expectedError });
    expect(response.body).not.toContain("sensitive");
    expect(response.body).not.toContain("secret");
  });

  it("sanitizes transport failures", async () => {
    const { app } = await makeGateway(async () => { throw new Error("private upstream address and details"); });
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const response = await app.inject({ method: "POST", url: "/webhooks/meta", headers: signedHeaders(body), payload: Buffer.from(body) });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "webhook_upstream_unavailable" });
    expect(response.body).not.toContain("private");
  });

  it("bounds upstream response consumption with the same five-second deadline", async () => {
    let wasAborted = false;
    const { app } = await makeGateway(async ({ init }) => {
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => {
            wasAborted = true;
            controller.error(new Error("aborted"));
          }, { once: true });
        }
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-webhook-normalized": "1",
          "x-webhook-enqueued": "1",
          "x-webhook-duplicates": "0",
          "x-webhook-unknown-channels": "0"
        }
      });
    });
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const response = await app.inject({ method: "POST", url: "/webhooks/meta", headers: signedHeaders(body), payload: Buffer.from(body) });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ error: "webhook_upstream_timeout" });
    expect(wasAborted).toBe(true);
  }, 10_000);
});
