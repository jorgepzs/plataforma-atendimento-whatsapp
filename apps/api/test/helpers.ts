import type { AppConfig } from "../src/config.js";
import type { NormalizedInboundMessage } from "../src/meta/inbound-message.js";
import type { EnqueueInboundResult, InboundEventStore } from "../src/ports/inbound-event-store.js";

export const testConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "silent",
  metaVerifyToken: "verify-secret",
  metaRequireSignature: true,
  metaAppSecret: "app-secret",
  metaGraphApiVersion: "v24.0",
  localAiEnabled: false,
  whatsappOutboundEnabled: false,
  whatsappOutboundAllowedRecipients: []
};

export class TestEventStore implements InboundEventStore {
  readonly kind = "memory" as const;
  readonly messages: NormalizedInboundMessage[] = [];
  ready = true;
  private readonly ids = new Set<string>();

  async enqueue(message: NormalizedInboundMessage): Promise<EnqueueInboundResult> {
    const key = `${message.provider}:${message.providerEventId}`;
    if (this.ids.has(key)) return "DUPLICATE";
    this.ids.add(key);
    this.messages.push(message);
    return "ENQUEUED";
  }

  async isReady(): Promise<boolean> { return this.ready; }
  async close(): Promise<void> {}
}

export function webhookPayload(id = "wamid.1", message: Record<string, unknown> = {}) {
  const messageContent = Object.keys(message).length > 0
    ? message
    : { type: "text", text: { body: "hello" } };

  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "phone-1" },
      contacts: [{ wa_id: "15551234567", profile: { name: "Ada" } }],
      messages: [{ id, from: "15551234567", timestamp: "1700000000", ...messageContent }]
    } }] }]
  };
}
