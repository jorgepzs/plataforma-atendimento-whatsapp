import { describe, expect, it } from "vitest";
import { LocalAttendanceService } from "../src/attendance/service.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { createLlmAssistant } from "../src/llm/assistant.js";
import type { LlmChatClient, LlmChatRequest } from "../src/llm/openai-chat-client.js";
import type { LlmSettings } from "../src/llm/settings.js";
import { isHistoricalOrderInquiry, isHistoricalOrderRepeatRequest } from "../src/ordering/intent.js";

const llmSettings: LlmSettings = {
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openai/gpt-4o-mini",
  timeoutMs: 1_000,
  maxRetries: 0,
  httpReferer: "https://example.com",
  appTitle: "Atendimento",
  failureMessage: "Não consegui responder agora.",
  failureAction: "reply_and_handoff",
  supportsTools: true,
  apiKey: "test-key"
};

const orderText = "quero uma calabresa grande para retirada";

function recordingClient(): { client: LlmChatClient; requests: LlmChatRequest[] } {
  const requests: LlmChatRequest[] = [];
  return {
    requests,
    client: {
      async complete(request) {
        requests.push(request);
        const currentText = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const hasToolResult = request.messages.some((message) => message.role === "tool");
        const canConfirm = request.tools?.some((tool) => tool.name === "confirm_order") ?? false;
        if (currentText === orderText && !hasToolResult) {
          return {
            ok: true,
            text: "",
            toolsDegraded: false,
            toolCalls: [
              { id: "add", name: "add_item", arguments: { itemId: "calabresa", quantity: 1, choiceIds: ["calabresa-grande"] } },
              { id: "pickup", name: "set_fulfillment", arguments: { method: "pickup" } },
              { id: "summary", name: "get_order_summary", arguments: {} }
            ]
          };
        }
        if (currentText === orderText && hasToolResult) {
          return { ok: true, text: "O total é R$ 63,00. Responda SIM para confirmar.", toolsDegraded: false, toolCalls: [] };
        }
        if (currentText === "sim" && canConfirm && !hasToolResult) {
          return {
            ok: true,
            text: "",
            toolsDegraded: false,
            toolCalls: [{ id: "confirm", name: "confirm_order", arguments: {} }]
          };
        }
        if (currentText === "sim" && canConfirm && hasToolResult) {
          return { ok: true, text: "Pedido confirmado.", toolsDegraded: false, toolCalls: [] };
        }
        return { ok: true, text: "Resposta do assistente.", toolsDegraded: false, toolCalls: [] };
      }
    }
  };
}

function createService(now: () => Date, client = recordingClient()) {
  const service = new LocalAttendanceService(new MemoryInboundEventStore(), {
    llmAssistant: createLlmAssistant(client.client, llmSettings),
    now,
    createId: (() => {
      let sequence = 0;
      return () => `bot-test-${++sequence}`;
    })(),
    workerIntervalMs: 60_000
  });
  return { service, requests: client.requests };
}

async function send(service: LocalAttendanceService, text: string, clientMessageId: string, phone = "5511991000042") {
  await service.simulateMessage("pizzaria-demo", {
    customerName: "Cliente",
    customerPhone: phone,
    text,
    clientMessageId
  });
  await service.processPending();
}

function lastUserText(request: LlmChatRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function latestRequestFor(requests: LlmChatRequest[], text: string): LlmChatRequest {
  const request = [...requests].reverse().find((candidate) => lastUserText(candidate) === text);
  if (!request) throw new Error(`LLM não recebeu a mensagem ${text}.`);
  return request;
}

describe("contexto de sessão do bot", () => {
  it("envia até oito falas recentes da sessão ativa em ordem e não inclui o começo antigo", async () => {
    let clock = Date.parse("2026-11-25T12:00:00.000Z");
    const { service, requests } = createService(() => new Date(clock));
    for (let index = 1; index <= 7; index += 1) {
      await send(service, `Pergunta ${index} sobre atendimento.`, `history-${index}`);
      clock += 1_000;
    }

    const request = latestRequestFor(requests, "Pergunta 7 sobre atendimento.");
    const history = request.messages.filter((message) => message.role !== "system");
    expect(history).toHaveLength(9); // oito falas anteriores e a mensagem atual
    expect(history[0]?.content).toBe("Pergunta 3 sobre atendimento.");
    expect(history[1]?.content).toBe("Resposta do assistente.");
    expect(history.at(-1)?.content).toBe("Pergunta 7 sobre atendimento.");
    expect(history.some((message) => message.content === "Pergunta 1 sobre atendimento.")).toBe(false);
  });

  it("exclui respostas bloqueadas que o cliente não recebeu do histórico enviado ao LLM", async () => {
    let clock = Date.parse("2026-11-25T12:00:00.000Z");
    const { service, requests } = createService(() => new Date(clock));
    await send(service, "Tenho uma dúvida sobre o atendimento.", "blocked-reply-1");
    const conversation = service.listConversations("pizzaria-demo")[0]!;
    const botReply = service.getConversation("pizzaria-demo", conversation.id).messages.at(-1)!;
    service.markDelivery("pizzaria-demo", botReply.id, { status: "BLOCKED", resultCode: "not_delivered" });

    clock += 1_000;
    await send(service, "Pode explicar mais?", "blocked-reply-2");

    const request = latestRequestFor(requests, "Pode explicar mais?");
    expect(request.messages.some((message) => message.role === "assistant" && message.content === "Resposta do assistente.")).toBe(false);
    expect(request.messages.filter((message) => message.role === "user").map((message) => message.content))
      .toEqual(["Tenho uma dúvida sobre o atendimento.", "Pode explicar mais?"]);
  });

  it("expira aos 60 minutos, mantém o pedido no histórico e não aceita SIM para o rascunho vencido", async () => {
    let clock = Date.parse("2026-11-25T12:00:00.000Z");
    const { service, requests } = createService(() => new Date(clock));
    await send(service, orderText, "expired-order-1");
    const oldOrder = service.listOrders("pizzaria-demo")[0]!;
    expect(oldOrder.status).toBe("awaiting_confirmation");

    clock += 60 * 60 * 1_000 + 1;
    await send(service, "sim", "expired-order-2");

    const afterExpiry = service.listOrders("pizzaria-demo")[0]!;
    expect(afterExpiry).toMatchObject({ id: oldOrder.id, status: "awaiting_confirmation", totalCents: oldOrder.totalCents });
    const request = latestRequestFor(requests, "sim");
    expect(request.messages.some((message) => message.role === "system" && message.content.includes("Pedido em aberto"))).toBe(false);
    expect(request.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(request.tools?.map((tool) => tool.name)).not.toContain("confirm_order");
    expect(request.tools?.map((tool) => tool.name)).not.toContain("update_item");
  });

  it("responde uma saudação sem resumir nem alterar um pedido aberto", async () => {
    let clock = Date.parse("2026-11-25T12:00:00.000Z");
    const { service, requests } = createService(() => new Date(clock));
    await send(service, orderText, "greeting-order-1");
    const before = service.listOrders("pizzaria-demo")[0]!;
    const requestCount = requests.length;

    clock += 1_000;
    await send(service, "oi", "greeting-order-2");

    expect(requests).toHaveLength(requestCount);
    expect(service.listOrders("pizzaria-demo")[0]).toMatchObject({
      id: before.id,
      status: before.status,
      totalCents: before.totalCents,
      updatedAt: before.updatedAt,
      summaryPresentedAt: before.summaryPresentedAt
    });
    const conversation = service.listConversations("pizzaria-demo")[0]!;
    expect(service.getConversation("pizzaria-demo", conversation.id).messages.at(-1)?.text)
      .toBe(service.getConfig("pizzaria-demo").config.greeting);

    clock += 1_000;
    await send(service, "sim", "greeting-order-3");
    expect(service.listOrders("pizzaria-demo")[0]?.status).toBe("confirmed");
    const confirmationRequest = latestRequestFor(requests, "sim");
    expect(confirmationRequest.tools?.map((tool) => tool.name)).toContain("confirm_order");
  });

  it("isola uma saudação de hoje do pedido confirmado de ontem e só expõe histórico quando solicitado", async () => {
    let clock = Date.parse("2026-11-25T12:00:00.000Z");
    const { service, requests } = createService(() => new Date(clock));
    await send(service, orderText, "yesterday-order-1");
    clock += 1_000;
    await send(service, "sim", "yesterday-order-2");
    const yesterdayOrder = service.listOrders("pizzaria-demo")[0]!;
    expect(yesterdayOrder.status).toBe("confirmed");

    clock += 24 * 60 * 60 * 1_000;
    await send(service, "oi", "yesterday-greeting");
    clock += 1_000;
    await send(service, "Pode me ajudar com uma informação?", "new-session-question");
    const currentRequest = latestRequestFor(requests, "Pode me ajudar com uma informação?");
    const currentHistory = currentRequest.messages.filter((message) => message.role !== "system");
    expect(currentHistory.map((message) => message.content)).toEqual([
      "oi",
      service.getConfig("pizzaria-demo").config.greeting,
      "Pode me ajudar com uma informação?"
    ]);
    expect(currentRequest.messages.some((message) => message.role === "system" &&
      (message.content.includes("Pedido em aberto") || message.content.includes("Consulta histórica solicitada")))).toBe(false);
    expect(service.listOrders("pizzaria-demo").find((order) => order.id === yesterdayOrder.id)?.status).toBe("confirmed");

    await send(service, "Qual foi meu pedido de ontem?", "explicit-history-question");
    const historyRequest = latestRequestFor(requests, "Qual foi meu pedido de ontem?");
    const systemPrompt = historyRequest.messages.find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("Consulta histórica solicitada pelo cliente");
    expect(systemPrompt).toContain("1× Pizza Calabresa");
    expect(historyRequest.tools?.map((tool) => tool.name)).not.toContain("confirm_order");

    await send(service, "Quero pedir igual ao de ontem.", "explicit-repeat-request");
    const repeatRequest = latestRequestFor(requests, "Quero pedir igual ao de ontem.");
    const orders = service.listOrders("pizzaria-demo");
    const newOrder = orders.find((order) => order.id !== yesterdayOrder.id);
    expect(newOrder).toMatchObject({
      status: "draft",
      lines: [{ itemId: "calabresa", quantity: 1, unitPriceCents: 6300 }]
    });
    expect(newOrder?.id).not.toBe(yesterdayOrder.id);
    expect(orders.find((order) => order.id === yesterdayOrder.id)?.status).toBe("confirmed");
    expect(repeatRequest.messages.find((message) => message.role === "system")?.content)
      .toContain("Um NOVO rascunho foi montado com os itens disponíveis e preços atuais");
    expect(repeatRequest.tools?.map((tool) => tool.name)).toContain("confirm_order");
  });

  it("reconhece pedido explícito de repetir/consultar, sem tratar uma menção temporal como consulta", () => {
    expect(isHistoricalOrderInquiry("Qual foi meu pedido de ontem?")).toBe(true);
    expect(isHistoricalOrderInquiry("Qual foi meu último pedido?")).toBe(true);
    expect(isHistoricalOrderInquiry("Quero pedir igual ao de ontem.")).toBe(true);
    expect(isHistoricalOrderRepeatRequest("Repete o pedido de ontem.")).toBe(true);
    expect(isHistoricalOrderRepeatRequest("Repete meu último pedido.")).toBe(true);
    expect(isHistoricalOrderRepeatRequest("Quero repetir meu pedido de ontem.")).toBe(true);
    expect(isHistoricalOrderInquiry("Repete a última pizza.")).toBe(true);
    expect(isHistoricalOrderInquiry("Ontem eu conversei sobre a loja.")).toBe(false);
    expect(isHistoricalOrderInquiry("Meu pedido foi ontem e hoje estou com dúvida.")).toBe(false);
  });
});
