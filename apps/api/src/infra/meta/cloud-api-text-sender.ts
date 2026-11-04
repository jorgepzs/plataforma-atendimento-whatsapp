import type {
  OutboundTextBlockedReason,
  OutboundTextHttpErrorCategory,
  OutboundTextInput,
  OutboundTextSendResult,
  OutboundTextSender
} from "../../ports/outbound-text-sender.js";

const serviceWindowMs = 24 * 60 * 60 * 1_000;
const defaultTimeoutMs = 10_000;
const maximumTimeoutMs = 120_000;
const graphApiHost = "https://graph.facebook.com";

export interface CloudApiTextSenderOptions {
  enabled?: boolean;
  graphApiVersion?: string;
  phoneNumberId?: string;
  accessToken?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

type RequestOutcome =
  | { kind: "http_error"; status: number }
  | { kind: "accepted"; messageId: string }
  | { kind: "invalid_success_response" }
  | { kind: "timeout" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getProviderMessageId(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;
  const firstMessage = payload.messages[0];
  if (!isRecord(firstMessage) || typeof firstMessage.id !== "string") return undefined;
  return /^wamid\.[A-Za-z0-9._=+/-]{1,512}$/.test(firstMessage.id) ? firstMessage.id : undefined;
}

function classifyHttpError(status: number): OutboundTextHttpErrorCategory {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_rejected";
}

function blocked(reason: OutboundTextBlockedReason): OutboundTextSendResult {
  return { status: "BLOCKED", reason };
}

/**
 * Strict, opt-in adapter for the WhatsApp Cloud API text endpoint.
 * Its fixed host and per-instance channel credentials are intentionally kept
 * out of the send input so callers cannot select another tenant's channel.
 */
export class CloudApiTextSender implements OutboundTextSender {
  private readonly enabled: boolean;
  private readonly graphApiVersion: string | undefined;
  private readonly phoneNumberId: string | undefined;
  private readonly accessToken: string | undefined;
  private readonly fetchTransport: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: CloudApiTextSenderOptions = {}) {
    this.enabled = options.enabled === true;
    this.graphApiVersion = options.graphApiVersion;
    this.phoneNumberId = options.phoneNumberId;
    this.accessToken = options.accessToken;
    this.fetchTransport = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  async sendText(input: OutboundTextInput): Promise<OutboundTextSendResult> {
    if (!this.enabled) return blocked("disabled");
    if (!this.hasValidConfiguration()) return blocked("invalid_configuration");
    if (!isRecord(input)) return blocked("invalid_input");

    if (typeof input.recipient !== "string" || !/^[1-9]\d{7,14}$/.test(input.recipient)) {
      return blocked("invalid_recipient");
    }
    if (
      typeof input.body !== "string" ||
      input.body.trim().length === 0 ||
      input.body.length > 4_096
    ) {
      return blocked("invalid_body");
    }
    if (!(input.lastInboundAt instanceof Date) || !Number.isFinite(input.lastInboundAt.getTime())) {
      return blocked("invalid_last_inbound_at");
    }

    let nowMs: number;
    try {
      const currentTime = this.now();
      nowMs = currentTime instanceof Date ? currentTime.getTime() : Number.NaN;
    } catch {
      return blocked("invalid_configuration");
    }
    if (!Number.isFinite(nowMs)) return blocked("invalid_configuration");

    const lastInboundAtMs = input.lastInboundAt.getTime();
    if (lastInboundAtMs > nowMs) return blocked("future_last_inbound_at");
    if (nowMs - lastInboundAtMs >= serviceWindowMs) return blocked("service_window_expired");

    const url = `${graphApiHost}/${this.graphApiVersion}/${this.phoneNumberId}/messages`;
    const requestBody = JSON.stringify({
      messaging_product: "whatsapp",
      to: input.recipient,
      type: "text",
      text: { body: input.body, preview_url: false }
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutOutcome = new Promise<RequestOutcome>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ kind: "timeout" });
      }, this.timeoutMs);
    });

    try {
      const requestOutcome = (async (): Promise<RequestOutcome> => {
        const response = await this.fetchTransport(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            "content-type": "application/json"
          },
          body: requestBody,
          redirect: "error",
          signal: controller.signal
        });

        if (!response.ok) {
          try {
            const cancellation = response.body?.cancel();
            if (cancellation) void cancellation.catch(() => undefined);
          } catch {
            // HTTP error details are intentionally discarded; cancellation is best effort.
          }
          return { kind: "http_error", status: response.status };
        }

        let responseBody: unknown;
        try {
          responseBody = await response.json();
        } catch {
          return { kind: "invalid_success_response" };
        }
        const messageId = getProviderMessageId(responseBody);
        return messageId
          ? { kind: "accepted", messageId }
          : { kind: "invalid_success_response" };
      })();

      const outcome = await Promise.race([requestOutcome, timeoutOutcome]);
      if (outcome.kind === "timeout" || timedOut) {
        return { status: "INDETERMINATE", reason: "timeout" };
      }
      if (outcome.kind === "http_error") {
        return {
          status: "HTTP_ERROR",
          httpStatus: outcome.status,
          category: classifyHttpError(outcome.status)
        };
      }
      if (outcome.kind === "invalid_success_response") {
        return { status: "INDETERMINATE", reason: "invalid_success_response" };
      }
      return { status: "ACCEPTED", providerMessageId: outcome.messageId };
    } catch {
      return {
        status: "INDETERMINATE",
        reason: timedOut ? "timeout" : "network_error"
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private hasValidConfiguration(): boolean {
    return Boolean(
      typeof this.graphApiVersion === "string" && /^v[1-9]\d*\.\d+$/.test(this.graphApiVersion) &&
      typeof this.phoneNumberId === "string" && /^[1-9]\d{0,31}$/.test(this.phoneNumberId) &&
      typeof this.accessToken === "string" && this.accessToken.length > 0 && !/\s/.test(this.accessToken) &&
      Number.isInteger(this.timeoutMs) && this.timeoutMs > 0 && this.timeoutMs <= maximumTimeoutMs &&
      typeof this.fetchTransport === "function"
    );
  }
}
