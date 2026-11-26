import { createHmac, timingSafeEqual } from "node:crypto";
import type { CustomerOrder } from "./types.js";

export interface OrderSinkTarget {
  webhookUrl?: string;
  webhookSecret?: string;
}

export interface OrderSinkResult {
  delivered: boolean;
  reference?: string;
  error?: string;
}

export interface OrderSink {
  deliver(order: CustomerOrder, target: OrderSinkTarget): Promise<OrderSinkResult>;
}

export function orderPayload(order: CustomerOrder): Record<string, unknown> {
  return {
    id: order.id,
    tenantId: order.tenantId,
    conversationId: order.conversationId,
    status: order.status,
    currency: order.currency,
    lines: order.lines,
    fulfillment: order.fulfillment,
    subtotalCents: order.subtotalCents,
    deliveryFeeCents: order.deliveryFeeCents,
    totalCents: order.totalCents,
    confirmedAt: order.confirmedAt
  };
}

export function signOrderPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function orderSignatureHeader(secret: string, body: string): string {
  return `sha256=${signOrderPayload(secret, body)}`;
}

export function verifyOrderSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = signOrderPayload(secret, body);
  const received = header.slice("sha256=".length);
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createWebhookOrderSink(fetcher: typeof fetch = fetch): OrderSink {
  return {
    async deliver(order, target) {
      if (!target.webhookUrl) return { delivered: true, reference: "local" };
      const body = JSON.stringify(orderPayload(order));
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-order-id": order.id
      };
      if (target.webhookSecret) headers["x-order-signature"] = orderSignatureHeader(target.webhookSecret, body);
      try {
        const response = await fetcher(target.webhookUrl, {
          method: "POST",
          headers,
          body,
          redirect: "error",
          cache: "no-store"
        });
        if (!response.ok) return { delivered: false, error: `http_${response.status}` };
        return { delivered: true, reference: response.headers.get("x-order-id") ?? order.id };
      } catch {
        return { delivered: false, error: "network" };
      }
    }
  };
}
