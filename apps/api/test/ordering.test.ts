import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LocalAttendanceService } from "../src/attendance/service.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { createLlmAssistant, type LlmChatClient, type LlmChatRequest } from "../src/llm/index.js";
import type { LlmSettings } from "../src/llm/settings.js";
import { quoteLine } from "../src/ordering/catalog.js";
import { pizzariaCatalog, pizzariaProfile } from "../src/ordering/seed.js";
import { OrderSession } from "../src/ordering/session.js";
import { createWebhookOrderSink, verifyOrderSignature } from "../src/ordering/sink.js";
import type { OrderSink } from "../src/ordering/sink.js";

const failureMessage = "Não consegui responder agora. Vou transferir você para uma pessoa.";

function settings(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    timeoutMs: 1_000,
    maxRetries: 0,
    httpReferer: "https://example.com",
    appTitle: "Plataforma de atendimento",
    failureMessage,
    failureAction: "reply_and_handoff",
    supportsTools: true,
    apiKey: "test-key",
    ...overrides
  };
}

function session(customerText: string, sink?: OrderSink, existing?: ConstructorParameters<typeof OrderSession>[0]["existing"]) {
  let sequence = 0;
  return new OrderSession({
    tenantId: "pizzaria-demo",
    conversationId: "conversation-1",
    catalog: pizzariaCatalog,
    profile: pizzariaProfile,
    existing: existing ?? null,
    customerText,
    now: () => new Date("2026-11-26T20:00:00.000Z"),
    createId: () => `id-${++sequence}`,
    sink: sink ?? { deliver: async () => ({ delivered: true, reference: "local" }) }
  });
}

describe("catalog pricing", () => {
  it("prices a pizza from the catalog and ignores a price sent by the caller", () => {
    const item = pizzariaCatalog.find((entry) => entry.id === "calabresa");
    expect(item).toBeDefined();
    const quoted = quoteLine(item!, 2, ["calabresa-grande", "calabresa-catupiry"]);
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.unitPriceCents).toBe(4800 + 1500 + 800);
    expect(quoted.lineTotalCents).toBe(7100 * 2);
  });

  it("rejects unknown items, bad quantities and missing required options", async () => {
    const tools = session("quero uma calabresa");
    expect((await tools.execute("add_item", { itemId: "inexistente", quantity: 1 })).error).toBe("unknown_item");
    expect((await tools.execute("add_item", { itemId: "calabresa", quantity: 0, choiceIds: ["calabresa-grande"] })).error).toBe("invalid_quantity");
    expect((await tools.execute("add_item", { itemId: "calabresa", quantity: 1, priceCents: 1 })).error).toBe("missing_choice");
    const added = await tools.execute("add_item", { itemId: "calabresa", quantity: 1, choiceIds: ["calabresa-grande"], priceCents: 1 });
    expect(added.ok).toBe(true);
    expect(tools.order()?.lines[0]?.unitPriceCents).toBe(6300);
    expect(tools.order()?.totalCents).toBe(6300);
  });
});

describe("order tools", () => {
  it("updates, removes and recomputes the delivery fee on the server", async () => {
    const tools = session("entrega na Rua A, 10");
    await tools.execute("add_item", { itemId: "coca-lata", quantity: 2 });
    await tools.execute("set_fulfillment", { method: "delivery", address: "Rua A, 10" });
    expect(tools.order()?.deliveryFeeCents).toBe(800);
    expect(tools.order()?.totalCents).toBe(700 * 2 + 800);
    const lineId = tools.order()?.lines[0]?.lineId ?? "";
    await tools.execute("update_item", { lineId, quantity: 1 });
    expect(tools.order()?.totalCents).toBe(700 + 800);
    await tools.execute("remove_item", { lineId });
    expect(tools.order()?.lines).toEqual([]);
    expect(tools.order()?.totalCents).toBe(800);
  });

  it("confirms only after the summary and an explicit customer yes", async () => {
    const tools = session("quero uma coca");
    await tools.execute("add_item", { itemId: "coca-lata", quantity: 1 });
    await tools.execute("set_fulfillment", { method: "pickup" });
    expect((await tools.execute("confirm_order", {})).error).toBe("summary_not_presented");
    expect((await tools.execute("get_order_summary", {})).ok).toBe(true);
    expect(tools.order()?.status).toBe("awaiting_confirmation");
    expect((await tools.execute("confirm_order", { confirmed: true })).error).toBe("summary_presented_this_turn");

    const ready = session("sim", undefined, tools.order());
    const confirmed = await ready.execute("confirm_order", { totalCents: 1 });
    expect(confirmed.ok).toBe(true);
    expect(ready.order()?.status).toBe("confirmed");
    expect(ready.order()?.totalCents).toBe(700);
    expect(ready.order()?.integrationReference).toBe("local");
  });

  it("não confirma quando o resumo e o SIM acontecem no mesmo turno", async () => {
    const tools = session("sim");
    await tools.execute("add_item", { itemId: "coca-lata", quantity: 1 });
    await tools.execute("set_fulfillment", { method: "pickup" });
    await tools.execute("get_order_summary", {});

    const confirmation = await tools.execute("confirm_order", {});
    expect(confirmation.error).toBe("summary_presented_this_turn");
    expect(tools.order()?.status).toBe("awaiting_confirmation");
  });
});

describe("no-tools fallback", () => {
  it("applies a JSON plan and replaces invented prices with the server total", async () => {
    const calls: LlmChatRequest[] = [];
    const client: LlmChatClient = {
      async complete(request) {
        calls.push(request);
        return {
          ok: true,
          text: "{\"reply\":\"Fica R$ 1,00\",\"confirm\":false,\"items\":[{\"itemId\":\"calabresa\",\"quantity\":1,\"choiceIds\":[\"calabresa-grande\"]}],\"fulfillment\":{\"method\":\"pickup\"}}",
          toolCalls: [],
          toolsDegraded: false
        };
      }
    };
    const tools = session("quero uma calabresa grande para retirada");
    const outcome = await createLlmAssistant(client, settings({ supportsTools: false })).completeTurn({
      businessName: "Pizzaria Demo",
      segment: "pizzaria",
      customerText: "quero uma calabresa grande para retirada",
      knowledge: [],
      profile: pizzariaProfile,
      catalog: pizzariaCatalog,
      orderingEnabled: true,
      session: tools
    });
    expect(outcome.kind).toBe("reply");
    if (outcome.kind !== "reply") return;
    expect(outcome.text).toContain("R$ 63,00");
    expect(outcome.text).not.toContain("R$ 1,00");
    expect(tools.order()?.status).toBe("awaiting_confirmation");
    expect(tools.order()?.totalCents).toBe(6300);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("matches a catalog item when the small model returns plain text", async () => {
    const client: LlmChatClient = {
      async complete() {
        return { ok: true, text: "Claro, a grande sai por R$ 20,00.", toolCalls: [], toolsDegraded: true };
      }
    };
    const service = new LocalAttendanceService(new MemoryInboundEventStore(), {
      llmAssistant: createLlmAssistant(client, settings()),
      workerIntervalMs: 60_000,
      now: () => new Date("2026-11-26T21:00:00.000Z"),
      createId: (() => {
        let sequence = 0;
        return () => `local-${++sequence}`;
      })()
    });
    await service.simulateMessage("pizzaria-demo", {
      customerName: "Ana",
      customerPhone: "5511991000099",
      text: "manda uma calabresa grande para retirada",
      clientMessageId: "fallback-1"
    });
    await service.processPending();
    const order = service.listOrders("pizzaria-demo")[0];
    expect(order?.lines[0]?.itemId).toBe("calabresa");
    expect(order?.totalCents).toBe(6300);
    expect(order?.status).toBe("awaiting_confirmation");
    const conversation = service.listConversations("pizzaria-demo")[0];
    expect(conversation?.state).toBe("BOT_ACTIVE");
    const detail = service.getConversation("pizzaria-demo", conversation!.id);
    expect(detail.messages[1]?.text).toContain("R$ 63,00");
    expect(detail.messages[1]?.text).not.toContain("R$ 20,00");
  });
});

describe("order sink", () => {
  it("signs the webhook body and leaves the order confirmed when the post fails", async () => {
    const bodies: string[] = [];
    const sink = createWebhookOrderSink(vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      const header = (init?.headers as Record<string, string>)["x-order-signature"];
      expect(verifyOrderSignature("segredo-de-teste", String(init?.body), header)).toBe(true);
      expect(header).toBe(`sha256=${createHmac("sha256", "segredo-de-teste").update(String(init?.body)).digest("hex")}`);
      return new Response("no", { status: 502 });
    }) as typeof fetch);
    const tools = session("sim", sink);
    await tools.execute("add_item", { itemId: "agua", quantity: 1 });
    await tools.execute("set_fulfillment", { method: "pickup" });
    await tools.execute("get_order_summary", {});
    const confirming = new OrderSession({
      tenantId: "pizzaria-demo",
      conversationId: "conversation-1",
      catalog: pizzariaCatalog,
      profile: pizzariaProfile,
      existing: tools.order(),
      customerText: "sim",
      now: () => new Date("2026-11-26T20:05:00.000Z"),
      createId: () => "generated",
      sink,
      webhookUrl: "https://pedidos.example/hooks/orders",
      webhookSecret: "segredo-de-teste"
    });
    const result = await confirming.execute("confirm_order", {});
    expect(result.ok).toBe(true);
    expect(confirming.order()?.status).toBe("confirmed");
    expect(confirming.order()?.integrationError).toBe("http_502");
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] ?? "{}").totalCents).toBe(400);
  });
});

describe("ordering conversation", () => {
  it("follows tool calls until the customer confirms, and keeps scheduling with a person", async () => {
    const client: LlmChatClient = {
      async complete(request) {
        const customer = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const sawTool = request.messages.some((message) => message.role === "tool");
        if (customer.startsWith("quero")) {
          if (!sawTool) {
            return {
              ok: true,
              text: "",
              toolsDegraded: false,
              toolCalls: [
                { id: "add", name: "add_item", arguments: { itemId: "calabresa", quantity: 1, choiceIds: ["calabresa-grande"] } },
                { id: "fee", name: "set_fulfillment", arguments: { method: "delivery", address: "Rua das Acácias, 50" } },
                { id: "sum", name: "get_order_summary", arguments: {} }
              ]
            };
          }
          return { ok: true, text: "Ficou R$ 71,00. Se estiver certo, responda SIM.", toolCalls: [], toolsDegraded: false };
        }
        if (!sawTool) {
          return { ok: true, text: "", toolsDegraded: false, toolCalls: [{ id: "ok", name: "confirm_order", arguments: { totalCents: 1 } }] };
        }
        return { ok: true, text: "Pedido confirmado. Total R$ 71,00.", toolCalls: [], toolsDegraded: false };
      }
    };
    const service = new LocalAttendanceService(new MemoryInboundEventStore(), {
      llmAssistant: createLlmAssistant(client, settings()),
      workerIntervalMs: 60_000
    });
    await service.simulateMessage("pizzaria-demo", {
      customerName: "Ana",
      customerPhone: "5511991000088",
      text: "quero uma calabresa grande para entrega na Rua das Acácias, 50",
      clientMessageId: "order-1"
    });
    await service.processPending();
    const draft = service.listOrders("pizzaria-demo")[0];
    expect(draft?.status).toBe("awaiting_confirmation");
    expect(draft?.totalCents).toBe(6300 + 800);
    expect(draft?.lines[0]?.unitPriceCents).toBe(6300);

    await service.simulateMessage("pizzaria-demo", {
      customerName: "Ana",
      customerPhone: "5511991000088",
      text: "sim",
      clientMessageId: "order-2"
    });
    await service.processPending();
    const confirmed = service.listOrders("pizzaria-demo")[0];
    expect(confirmed?.status).toBe("confirmed");
    expect(confirmed?.totalCents).toBe(7100);
    const conversation = service.listConversations("pizzaria-demo")[0]!;
    expect(conversation.state).toBe("BOT_ACTIVE");
    expect(service.getConversation("pizzaria-demo", conversation.id).messages.at(-1)?.text).toContain("Pedido confirmado");

    const cancelled = service.updateOrderStatus("pizzaria-demo", confirmed!.id, "cancelled");
    expect(cancelled.status).toBe("cancelled");

    await service.simulateMessage("barbearia-demo", {
      customerName: "Bia",
      customerPhone: "5511991000077",
      text: "Gostaria de agendar um horário para corte amanhã.",
      clientMessageId: "barber-1"
    });
    await service.processPending();
    expect(service.listConversations("barbearia-demo")[0]?.state).toBe("WAITING_HUMAN");
    expect(service.listOrders("barbearia-demo")).toEqual([]);
  });

  it("usa resumo calculado no servidor e não aceita SIM se o resumo anterior falhou", async () => {
    const client: LlmChatClient = {
      async complete(request) {
        const customer = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const sawTool = request.messages.some((message) => message.role === "tool");
        if (customer === "quero uma coca para retirada" && !sawTool) {
          return {
            ok: true,
            text: "",
            toolsDegraded: false,
            toolCalls: [
              { id: "add", name: "add_item", arguments: { itemId: "coca-lata", quantity: 1 } },
              { id: "pickup", name: "set_fulfillment", arguments: { method: "pickup" } },
              { id: "summary", name: "get_order_summary", arguments: {} }
            ]
          };
        }
        if (customer === "sim" && !sawTool) {
          return {
            ok: true,
            text: "",
            toolsDegraded: false,
            toolCalls: [
              { id: "summary-again", name: "get_order_summary", arguments: {} },
              { id: "confirm", name: "confirm_order", arguments: {} }
            ]
          };
        }
        return { ok: true, text: "Pode confirmar?", toolsDegraded: false, toolCalls: [] };
      }
    };
    const service = new LocalAttendanceService(new MemoryInboundEventStore(), {
      llmAssistant: createLlmAssistant(client, settings()),
      workerIntervalMs: 60_000
    });
    await service.simulateMessage("pizzaria-demo", {
      customerName: "Ana",
      customerPhone: "5511991000089",
      text: "quero uma coca para retirada",
      clientMessageId: "order-summary-delivery-1"
    });
    await service.processPending();

    const conversation = service.listConversations("pizzaria-demo")[0]!;
    const firstSummary = service.getConversation("pizzaria-demo", conversation.id).messages.at(-1)!;
    expect(firstSummary.text).toContain("Resumo do pedido:");
    expect(firstSummary.text).toContain("Total: R$ 7,00");
    expect(service.listOrders("pizzaria-demo")[0]?.status).toBe("awaiting_confirmation");
    service.markDelivery("pizzaria-demo", firstSummary.id, { status: "BLOCKED", resultCode: "not_delivered" });

    await service.simulateMessage("pizzaria-demo", {
      customerName: "Ana",
      customerPhone: "5511991000089",
      text: "sim",
      clientMessageId: "order-summary-delivery-2"
    });
    await service.processPending();

    expect(service.listOrders("pizzaria-demo")[0]?.status).toBe("awaiting_confirmation");
    const finalConversation = service.getConversation("pizzaria-demo", conversation.id);
    expect(finalConversation.messages.at(-1)?.text).toContain("Resumo do pedido:");
    expect(finalConversation.messages.at(-1)?.text).toContain("Total: R$ 7,00");
  });
});
