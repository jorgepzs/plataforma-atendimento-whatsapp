export type InboundMessageType =
  | "text"
  | "interactive"
  | "button"
  | "image"
  | "audio"
  | "document"
  | "video"
  | "location"
  | "contacts"
  | "unknown";

/** Set by a trusted ingress adapter, never accepted from an HTTP message body. */
export type InboundSource = "META_WEBHOOK" | "LOCAL_SIMULATOR" | "LEGACY_UNKNOWN";

export interface NormalizedInboundMessage {
  provider: "META_WHATSAPP";
  source: InboundSource;
  providerEventId: string;
  providerPhoneNumberId: string;
  consumerPhoneNumber: string;
  consumerProfileName?: string;
  occurredAt: Date;
  type: InboundMessageType;
  text?: string;
  mediaId?: string;
  rawMessage: Record<string, unknown>;
}

