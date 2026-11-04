export interface OutboundTextInput {
  recipient: string;
  body: string;
  /** Timestamp of the latest consumer message, obtained from trusted inbound data. */
  lastInboundAt: Date;
}

export type OutboundTextBlockedReason =
  | "disabled"
  | "invalid_configuration"
  | "invalid_input"
  | "invalid_recipient"
  | "invalid_body"
  | "invalid_last_inbound_at"
  | "future_last_inbound_at"
  | "service_window_expired";

export type OutboundTextIndeterminateReason =
  | "timeout"
  | "network_error"
  | "invalid_success_response";

export type OutboundTextHttpErrorCategory =
  | "unauthorized"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_rejected";

export type OutboundTextSendResult =
  | { status: "BLOCKED"; reason: OutboundTextBlockedReason }
  | { status: "HTTP_ERROR"; httpStatus: number; category: OutboundTextHttpErrorCategory }
  | { status: "ACCEPTED"; providerMessageId: string }
  | { status: "INDETERMINATE"; reason: OutboundTextIndeterminateReason };

export interface OutboundTextSender {
  sendText(input: OutboundTextInput): Promise<OutboundTextSendResult>;
}
