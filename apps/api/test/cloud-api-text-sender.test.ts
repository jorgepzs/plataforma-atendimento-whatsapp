import { describe, expect, it } from "vitest";
import {
  CloudApiTextSender,
  type CloudApiTextSenderOptions
} from "../src/infra/meta/cloud-api-text-sender.js";
import type { OutboundTextInput } from "../src/ports/outbound-text-sender.js";

const accessToken = "private-access-token-for-test";
const fixedNow = new Date("2026-10-03T12:00:00.000Z");
const validInput: OutboundTextInput = {
  recipient: "5511999990000",
  body: "Olá! Posso ajudar?",
  lastInboundAt: new Date("2026-10-03T11:59:00.000Z")
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

function senderFor(
  respond: () => Promise<Response>,
  options: Partial<CloudApiTextSenderOptions> = {}
) {
  const calls: FetchCall[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  };
  const sender = new CloudApiTextSender({
    enabled: true,
    graphApiVersion: "v24.0",
    phoneNumberId: "123456789012345",
    accessToken,
    now: () => new Date(fixedNow),
    fetch: fakeFetch,
    ...options
  });
  return { sender, calls };
}

function acceptedResponse(id = "wamid.HBgMNTUxMTk5OTk5MDAwMBUCABIYFjNFQjA=") {
  return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("CloudApiTextSender", () => {
  it("posts only the scoped text body to the fixed Graph URL and reports provider acceptance", async () => {
    const providerId = "wamid.HBgMNTUxMTk5OTk5MDAwMBUCABIYFjNFQjA+/=";
    const { sender, calls } = senderFor(async () => acceptedResponse(providerId));

    const result = await sender.sendText(validInput);

    expect(result).toEqual({
      status: "ACCEPTED",
      providerMessageId: providerId
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v24.0/123456789012345/messages");
    const init = calls[0]!.init;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: "whatsapp",
      to: validInput.recipient,
      type: "text",
      text: { body: validInput.body, preview_url: false }
    });
  });

  it("is disabled by default and performs no transport", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return acceptedResponse();
    };
    const sender = new CloudApiTextSender({
      graphApiVersion: "v24.0",
      phoneNumberId: "123456789012345",
      accessToken,
      fetch: fakeFetch
    });

    await expect(sender.sendText(validInput)).resolves.toEqual({ status: "BLOCKED", reason: "disabled" });
    expect(calls).toBe(0);
  });

  it("does not treat a runtime string as enabled", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return acceptedResponse();
    };
    const options = {
      enabled: "false",
      graphApiVersion: "v24.0",
      phoneNumberId: "123456789012345",
      accessToken,
      fetch: fakeFetch
    } as unknown as CloudApiTextSenderOptions;
    const sender = new CloudApiTextSender(options);

    await expect(sender.sendText(validInput)).resolves.toEqual({ status: "BLOCKED", reason: "disabled" });
    expect(calls).toBe(0);
  });

  it("fails closed for invalid configuration, recipient, body and UTF-16 length", async () => {
    const { sender, calls } = senderFor(async () => acceptedResponse());
    const invalidConfig = senderFor(async () => acceptedResponse(), { graphApiVersion: "https://other.example" });

    await expect(invalidConfig.sender.sendText(validInput)).resolves.toEqual({ status: "BLOCKED", reason: "invalid_configuration" });
    expect(invalidConfig.calls).toHaveLength(0);
    let missingConfigCalls = 0;
    const noNetworkFetch: typeof fetch = async () => {
      missingConfigCalls += 1;
      throw new Error("Fetch offline não deveria ser chamado.");
    };
    const missingToken = new CloudApiTextSender({
      enabled: true,
      graphApiVersion: "v24.0",
      phoneNumberId: "123456789012345",
      fetch: noNetworkFetch
    });
    const missingPhoneId = new CloudApiTextSender({
      enabled: true,
      graphApiVersion: "v24.0",
      accessToken,
      fetch: noNetworkFetch
    });
    const injectedPhoneId = senderFor(async () => acceptedResponse(), { phoneNumberId: "123/messages?access_token=secret" });
    const zeroPhoneId = senderFor(async () => acceptedResponse(), { phoneNumberId: "0" });
    await expect(missingToken.sendText(validInput)).resolves.toEqual({ status: "BLOCKED", reason: "invalid_configuration" });
    await expect(missingPhoneId.sendText(validInput)).resolves.toEqual({ status: "BLOCKED", reason: "invalid_configuration" });
    await expect(injectedPhoneId.sender.sendText(validInput)).resolves.toEqual({ status: "BLOCKED", reason: "invalid_configuration" });
    await expect(zeroPhoneId.sender.sendText(validInput)).resolves.toEqual({ status: "BLOCKED", reason: "invalid_configuration" });
    expect(missingConfigCalls).toBe(0);
    expect(injectedPhoneId.calls).toHaveLength(0);
    expect(zeroPhoneId.calls).toHaveLength(0);
    await expect(sender.sendText(null as unknown as OutboundTextInput)).resolves.toEqual({ status: "BLOCKED", reason: "invalid_input" });
    await expect(sender.sendText({ body: 123 } as unknown as OutboundTextInput)).resolves.toEqual({ status: "BLOCKED", reason: "invalid_recipient" });
    await expect(sender.sendText({ ...validInput, recipient: "+5511999990000" })).resolves.toEqual({ status: "BLOCKED", reason: "invalid_recipient" });
    await expect(sender.sendText({ ...validInput, recipient: "0123456789" })).resolves.toEqual({ status: "BLOCKED", reason: "invalid_recipient" });
    await expect(sender.sendText({ ...validInput, body: "  \n " })).resolves.toEqual({ status: "BLOCKED", reason: "invalid_body" });
    await expect(sender.sendText({ ...validInput, body: "x".repeat(4_097) })).resolves.toEqual({ status: "BLOCKED", reason: "invalid_body" });
    await expect(sender.sendText({ ...validInput, body: "😀".repeat(2_048) })).resolves.toMatchObject({ status: "ACCEPTED" });
    expect(calls).toHaveLength(1);
  });

  it("blocks invalid, future and expired inbound timestamps before transport", async () => {
    const { sender, calls } = senderFor(async () => acceptedResponse());
    const expiredAtExactBoundary = new Date(fixedNow.getTime() - 24 * 60 * 60 * 1_000);

    await expect(sender.sendText({ ...validInput, lastInboundAt: new Date(Number.NaN) }))
      .resolves.toEqual({ status: "BLOCKED", reason: "invalid_last_inbound_at" });
    await expect(sender.sendText({ ...validInput, lastInboundAt: new Date(fixedNow.getTime() + 1) }))
      .resolves.toEqual({ status: "BLOCKED", reason: "future_last_inbound_at" });
    await expect(sender.sendText({ ...validInput, lastInboundAt: expiredAtExactBoundary }))
      .resolves.toEqual({ status: "BLOCKED", reason: "service_window_expired" });
    await expect(sender.sendText({
      ...validInput,
      lastInboundAt: new Date(expiredAtExactBoundary.getTime() + 1)
    })).resolves.toMatchObject({ status: "ACCEPTED" });
    expect(calls).toHaveLength(1);
  });

  it("blocks an invalid injected clock before transport", async () => {
    const { sender, calls } = senderFor(async () => acceptedResponse(), { now: () => new Date(Number.NaN) });

    await expect(sender.sendText(validInput)).resolves.toEqual({ status: "BLOCKED", reason: "invalid_configuration" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, "unauthorized"],
    [429, "rate_limited"],
    [500, "provider_unavailable"]
  ] as const)("sanitizes HTTP %i without retrying", async (status, category) => {
    const { sender, calls } = senderFor(async () => new Response(
      JSON.stringify({ error: { message: `sensitive-provider-body ${accessToken}` } }),
      { status, headers: { "content-type": "application/json" } }
    ));

    const result = await sender.sendText(validInput);

    expect(result).toEqual({ status: "HTTP_ERROR", httpStatus: status, category });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.stringify(result)).not.toContain("sensitive-provider-body");
    expect(calls).toHaveLength(1);
  });

  it("reports network failures safely and never retries the POST", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      throw new Error(`private network detail ${accessToken}`);
    };
    const sender = new CloudApiTextSender({
      enabled: true,
      graphApiVersion: "v24.0",
      phoneNumberId: "123456789012345",
      accessToken,
      now: () => new Date(fixedNow),
      fetch: fakeFetch
    });

    const result = await sender.sendText(validInput);

    expect(result).toEqual({ status: "INDETERMINATE", reason: "network_error" });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(JSON.stringify(result)).not.toContain("private network detail");
    expect(calls).toBe(1);
  });

  it("cancels an HTTP error body without exposing it", async () => {
    let cancellations = 0;
    const fakeFetch: typeof fetch = async () => ({
      ok: false,
      status: 401,
      body: { cancel: () => { cancellations += 1; return Promise.resolve(); } }
    } as unknown as Response);
    const sender = new CloudApiTextSender({
      enabled: true,
      graphApiVersion: "v24.0",
      phoneNumberId: "123456789012345",
      accessToken,
      now: () => new Date(fixedNow),
      fetch: fakeFetch
    });

    await expect(sender.sendText(validInput)).resolves.toEqual({ status: "HTTP_ERROR", httpStatus: 401, category: "unauthorized" });
    expect(cancellations).toBe(1);
  });

  it.each(["request", "response body"] as const)("aborts on timeout while awaiting the %s", async (phase) => {
    let calls = 0;
    let observedSignal: AbortSignal | null | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      calls += 1;
      observedSignal = init?.signal;
      if (phase === "request") {
        // Simulate a fetch implementation that ignores abort and never settles.
        return new Promise<Response>(() => undefined);
      }
      return {
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => undefined)
      } as unknown as Response;
    };
    const sender = new CloudApiTextSender({
      enabled: true,
      graphApiVersion: "v24.0",
      phoneNumberId: "123456789012345",
      accessToken,
      now: () => new Date(fixedNow),
      timeoutMs: 5,
      fetch: fakeFetch
    });

    const result = await sender.sendText(validInput);

    expect(result).toEqual({ status: "INDETERMINATE", reason: "timeout" });
    expect(observedSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
  });

  it("treats malformed or incomplete 2xx responses as indeterminate", async () => {
    const malformed = senderFor(async () => new Response("not-json", { status: 200 }));
    const missingId = senderFor(async () => new Response(JSON.stringify({ messages: [{}] }), { status: 200 }));

    await expect(malformed.sender.sendText(validInput)).resolves.toEqual({ status: "INDETERMINATE", reason: "invalid_success_response" });
    await expect(missingId.sender.sendText(validInput)).resolves.toEqual({ status: "INDETERMINATE", reason: "invalid_success_response" });
    expect(malformed.calls).toHaveLength(1);
    expect(missingId.calls).toHaveLength(1);
  });
});
