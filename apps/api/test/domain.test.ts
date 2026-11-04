import { describe, expect, it } from "vitest";
import { assertConversationTransition, canTransitionConversation, InvalidConversationTransitionError } from "../src/domain/conversation-state.js";
import { evaluateMessageCostPolicy } from "../src/domain/message-cost-policy.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { normalizeMetaWebhook } from "../src/meta/normalize-webhook.js";
import { webhookPayload } from "./helpers.js";

describe("webhook normalization", () => {
  it("normalizes text, profile and timestamp", () => {
    const [message] = normalizeMetaWebhook(webhookPayload("text-id"));
    expect(message).toMatchObject({ providerEventId: "text-id", providerPhoneNumberId: "phone-1", consumerPhoneNumber: "15551234567", consumerProfileName: "Ada", text: "hello", type: "text" });
    expect(message?.occurredAt.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it.each([
    [{ type: "interactive", interactive: { type: "button_reply", button_reply: { title: "Sim" } } }, "Sim"],
    [{ type: "interactive", interactive: { type: "list_reply", list_reply: { title: "Opção" } } }, "Opção"],
    [{ type: "button", button: { text: "Continuar" } }, "Continuar"]
  ])("extracts interactive or button text", (messageFields, expected) => {
    expect(normalizeMetaWebhook(webhookPayload("interactive-id", messageFields))[0]?.text).toBe(expected);
  });

  it("extracts media IDs", () => {
    const payload = webhookPayload("image-id", { type: "image", image: { id: "media-1" } });
    expect(normalizeMetaWebhook(payload)[0]?.mediaId).toBe("media-1");
  });

  it("rejects message-bearing changes without a phone number ID", () => {
    const payload = { entry: [{ changes: [{ value: { messages: [{ id: "x", from: "1", timestamp: "0" }] } }] }] };
    expect(() => normalizeMetaWebhook(payload)).toThrow(/phone_number_id/);
  });

  it("accepts empty and status-only callbacks without creating inbound messages", () => {
    expect(normalizeMetaWebhook({ object: "whatsapp_business_account", entry: [] })).toEqual([]);
    expect(normalizeMetaWebhook({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {
        statuses: [{ id: "wamid.outbound-no-metadata", status: "delivered" }]
      } }] }]
    })).toEqual([]);
    expect(normalizeMetaWebhook({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "phone-1" },
        statuses: [{ id: "wamid.outbound", status: "delivered" }]
      } }] }]
    })).toEqual([]);
  });

  it("normalizes a batch containing messages for multiple phone number IDs", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ changes: [
        { value: { metadata: { phone_number_id: "phone-a" }, messages: [
          { id: "wamid.a", from: "15550000001", timestamp: "1700000000", type: "text", text: { body: "A" } }
        ] } },
        { value: { metadata: { phone_number_id: "phone-b" }, messages: [
          { id: "wamid.b", from: "15550000002", timestamp: "1700000001", type: "text", text: { body: "B" } }
        ] } }
      ] }]
    };

    expect(normalizeMetaWebhook(payload).map(({ providerEventId, providerPhoneNumberId }) => ({ providerEventId, providerPhoneNumberId }))).toEqual([
      { providerEventId: "wamid.a", providerPhoneNumberId: "phone-a" },
      { providerEventId: "wamid.b", providerPhoneNumberId: "phone-b" }
    ]);
  });

  it("rejects malformed webhook structure", () => {
    expect(() => normalizeMetaWebhook({ entry: "invalid" })).toThrow();
  });
});

describe("in-memory event deduplication", () => {
  it("keys duplicates by provider and provider event ID", async () => {
    const store = new MemoryInboundEventStore();
    const message = normalizeMetaWebhook(webhookPayload("same"))[0]!;
    expect(await store.enqueue(message)).toBe("ENQUEUED");
    expect(await store.enqueue({ ...message, text: "changed" })).toBe("DUPLICATE");
    expect(store.messages).toHaveLength(1);
    expect(await store.isReady()).toBe(true);
    await store.close();
  });
});

describe("conversation state transitions", () => {
  it("allows self transitions and the declared lifecycle", () => {
    expect(canTransitionConversation("BOT_ACTIVE", "BOT_ACTIVE")).toBe(true);
    expect(canTransitionConversation("BOT_ACTIVE", "WAITING_HUMAN")).toBe(true);
    expect(canTransitionConversation("WAITING_HUMAN", "HUMAN_ACTIVE")).toBe(true);
    expect(canTransitionConversation("HUMAN_ACTIVE", "CLOSED")).toBe(true);
    expect(canTransitionConversation("CLOSED", "BOT_ACTIVE")).toBe(true);
    expect(() => assertConversationTransition("WAITING_HUMAN", "HUMAN_ACTIVE")).not.toThrow();
  });

  it("rejects unsupported transitions", () => {
    expect(canTransitionConversation("BOT_ACTIVE", "HUMAN_ACTIVE")).toBe(false);
    expect(() => assertConversationTransition("BOT_ACTIVE", "HUMAN_ACTIVE")).toThrow(InvalidConversationTransitionError);
    expect(canTransitionConversation("CLOSED", "WAITING_HUMAN")).toBe(false);
  });
});

describe("message cost policy", () => {
  const now = new Date("2026-10-03T12:00:00.000Z");
  const expiresSoon = new Date("2026-10-03T12:01:00.000Z");
  const expired = new Date("2026-10-03T11:59:00.000Z");
  const decide = (overrides: Partial<Parameters<typeof evaluateMessageCostPolicy>[0]> = {}) => evaluateMessageCostPolicy({
    category: "SERVICE", customerServiceWindowExpiresAt: expiresSoon, now, allowPaidMessages: false, allowProactiveMessages: false, ...overrides
  });

  it("allows service and utility within the open customer service window", () => {
    expect(decide()).toEqual({ allowed: true, reason: "OPEN_SERVICE_WINDOW" });
    expect(decide({ category: "UTILITY" })).toEqual({ allowed: true, reason: "OPEN_SERVICE_WINDOW" });
  });

  it("blocks proactive sends when disabled and paid sends when payment is disabled", () => {
    expect(decide({ category: "MARKETING", customerServiceWindowExpiresAt: null })).toEqual({ allowed: false, reason: "PROACTIVE_MESSAGES_DISABLED" });
    expect(decide({ category: "MARKETING", allowProactiveMessages: true })).toEqual({ allowed: false, reason: "PAID_MESSAGES_DISABLED" });
    expect(decide({ category: "SERVICE", customerServiceWindowExpiresAt: expired, allowProactiveMessages: true })).toEqual({ allowed: false, reason: "SERVICE_WINDOW_CLOSED" });
  });

  it("allows paid proactive messages only when both switches are enabled", () => {
    expect(decide({ category: "MARKETING", allowProactiveMessages: true, allowPaidMessages: true })).toEqual({ allowed: true, reason: "PAID_MESSAGES_ENABLED" });
  });

  it("treats the exact expiry instant as outside the service window", () => {
    expect(decide({ customerServiceWindowExpiresAt: now })).toEqual({ allowed: false, reason: "PROACTIVE_MESSAGES_DISABLED" });
  });
});
