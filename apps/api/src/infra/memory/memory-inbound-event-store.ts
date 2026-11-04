import type { NormalizedInboundMessage } from "../../meta/inbound-message.js";
import type { EnqueueInboundResult, InboundEventStore } from "../../ports/inbound-event-store.js";

export class MemoryInboundEventStore implements InboundEventStore {
  readonly kind = "memory" as const;
  readonly messages: NormalizedInboundMessage[] = [];
  private readonly identifiers = new Set<string>();
  private readonly pending: NormalizedInboundMessage[] = [];

  async enqueue(message: NormalizedInboundMessage): Promise<EnqueueInboundResult> {
    const key = `${message.provider}:${message.providerEventId}`;
    if (this.identifiers.has(key)) {
      return "DUPLICATE";
    }

    this.identifiers.add(key);
    this.messages.push(message);
    this.pending.push(message);
    return "ENQUEUED";
  }

  takePending(): NormalizedInboundMessage | undefined {
    return this.pending.shift();
  }

  requeue(message: NormalizedInboundMessage): void {
    this.pending.push(message);
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // Não há recursos externos no armazenamento em memória.
  }
}

