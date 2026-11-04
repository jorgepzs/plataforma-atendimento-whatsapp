import type { NormalizedInboundMessage } from "../meta/inbound-message.js";

export type EnqueueInboundResult = "ENQUEUED" | "DUPLICATE" | "UNKNOWN_CHANNEL";

export interface InboundEventStore {
  readonly kind: "memory" | "postgres" | "sqlite";
  enqueue(message: NormalizedInboundMessage): Promise<EnqueueInboundResult>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}

