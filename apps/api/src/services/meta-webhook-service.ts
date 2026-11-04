import { normalizeMetaWebhook } from "../meta/normalize-webhook.js";
import type { InboundEventStore } from "../ports/inbound-event-store.js";

export interface WebhookProcessingSummary {
  normalized: number;
  enqueued: number;
  duplicates: number;
  unknownChannels: number;
}

export class MetaWebhookService {
  constructor(private readonly store: InboundEventStore) {}

  async accept(payload: unknown): Promise<WebhookProcessingSummary> {
    const messages = normalizeMetaWebhook(payload);
    const summary: WebhookProcessingSummary = {
      normalized: messages.length,
      enqueued: 0,
      duplicates: 0,
      unknownChannels: 0
    };

    for (const message of messages) {
      const result = await this.store.enqueue(message);
      if (result === "ENQUEUED") {
        summary.enqueued += 1;
      } else if (result === "DUPLICATE") {
        summary.duplicates += 1;
      } else {
        summary.unknownChannels += 1;
      }
    }

    return summary;
  }
}

