import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { LocalAttendanceService } from "../src/attendance/service.js";
import type { AttendanceSnapshot, AttendanceStateRepository, UpdateTenantConfigInput } from "../src/attendance/types.js";
import type { KnowledgeAnswerSelector } from "../src/attendance/knowledge-classifier.js";
import type { AppConfig } from "../src/config.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { createLlmAssistant, type LlmAssistant } from "../src/llm/assistant.js";
import { OpenAiCompatibleChatClient, type LlmChatClient, type LlmChatRequest } from "../src/llm/openai-chat-client.js";
import type { LlmSettings } from "../src/llm/settings.js";
import { testConfig } from "./helpers.js";

const failureMessage = "Não consegui responder agora. Vou transferir você para uma pessoa.";

function settings(overrides: Omit<Partial<LlmSettings>, "apiKey"> & { apiKey?: string } = {}): LlmSettings {
  const { apiKey = "global-secret", ...rest } = overrides;
  const resolved: LlmSettings = {
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
    ...rest
  };
  if (apiKey) resolved.apiKey = apiKey;
  return resolved;
}

function completion(content: string | null, toolCalls?: unknown[]): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function recordingClient(handler: (request: LlmChatRequest) => ReturnType<LlmChatClient["complete"]>): {
  client: LlmChatClient;
  requests: LlmChatRequest[];
} {
  const requests: LlmChatRequest[] = [];
  return {
    requests,
    client: {
      async complete(request) {
        requests.push(request);
        return handler(request);
      }
    }
  };
}

function createService(client: LlmChatClient, llm = settings(), selector?: KnowledgeAnswerSelector, repository?: AttendanceStateRepository) {
  const store = new MemoryInboundEventStore();
  const service = new LocalAttendanceService(store, {
    llmAssistant: createLlmAssistant(client, llm),
    ...(selector ? { knowledgeAnswerSelector: selector } : {}),
    ...(repository ? { repository } : {}),
    workerIntervalMs: 60_000
  });
  return { service, store };
}

function configUpdate(service: LocalAttendanceService, tenantId: string, extra: Partial<UpdateTenantConfigInput> = {}): UpdateTenantConfigInput {
  const { config } = service.getConfig(tenantId);
  return {
    businessName: config.businessName,
    segment: config.segment,
    greeting: config.greeting,
    knowledge: config.knowledge,
    handoffKeywords: config.handoffKeywords,
    assistantMode: config.assistantMode,
    version: config.version,
    ...extra
  };
}

async function ask(service: LocalAttendanceService, text: string, phone: string, tenantId = "pizzaria-demo") {
  await service.simulateMessage(tenantId, {
    customerName: "Cliente",
    customerPhone: phone,
    text,
    clientMessageId: `${phone}:${text}`
  });
  await service.processPending();
  const conversation = service.listConversations(tenantId).find((item) => item.customerPhone === phone);
  if (!conversation) throw new Error("Conversa não encontrada.");
  return service.getConversation(tenantId, conversation.id);
}

describe("LLM gateway in the attendance worker", () => {
  it("answers from the gateway and skips it for FAQ, greetings and human-only requests", async () => {
    const { client, requests } = recordingClient(async () => ({
      ok: true,
      text: "Funcionamos todos os dias, das 18h às 23h.",
      toolCalls: [],
      toolsDegraded: false
    }));
    const { service } = createService(client);

    const exact = await ask(service, "Qual é o horário de funcionamento?", "5511991000001");
    expect(requests).toHaveLength(0);
    expect(exact.messages.map((message) => message.text)).toEqual([
      "Qual é o horário de funcionamento?",
      "Funcionamos todos os dias, das 18h às 23h."
    ]);
    expect(exact.conversation.state).toBe("BOT_ACTIVE");

    const greeting = await ask(service, "oi", "5511991000002");
    expect(requests).toHaveLength(0);
    expect(greeting.conversation.state).toBe("BOT_ACTIVE");

    const order = await ask(service, "quero reservar uma mesa para hoje", "5511991000003");
    expect(requests).toHaveLength(0);
    expect(order.conversation.state).toBe("WAITING_HUMAN");
    expect(order.messages).toHaveLength(1);

    const paraphrase = await ask(service, "Vocês abrem de noite?", "5511991000004");
    expect(requests).toHaveLength(1);
    expect(paraphrase.conversation.state).toBe("BOT_ACTIVE");
    expect(paraphrase.messages.map((message) => message.text)[1]).toBe("Funcionamos todos os dias, das 18h às 23h.");
    const serialized = JSON.stringify(requests[0]);
    expect(serialized).not.toContain("5511991000004");
    expect(requests[0]?.settings.provider).toBe("openrouter");
    expect(requests[0]?.messages.some((message) => message.role === "user" && message.content === "Vocês abrem de noite?")).toBe(true);
  });

  it("uses the tenant provider, model and key, and keeps the key out of the API response", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => completion("Resposta da empresa."));
    const client = new OpenAiCompatibleChatClient({ fetcher: fetcher as typeof fetch, sleep: async () => undefined });
    let snapshot: AttendanceSnapshot | undefined;
    const repository: AttendanceStateRepository = {
      load: () => snapshot,
      save: (next) => { snapshot = next; }
    };
    const first = createService(client, settings(), undefined, repository);
    first.service.updateConfig("pizzaria-demo", configUpdate(first.service, "pizzaria-demo", {
      llm: {
        provider: "local",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "llama3",
        apiKey: "tenant-secret"
      }
    }));
    const visible = first.service.getConfig("pizzaria-demo").config.llm;
    expect(visible).toEqual({ provider: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "llama3" });
    expect(JSON.stringify(first.service.getConfig("pizzaria-demo"))).not.toContain("tenant-secret");

    first.service.updateConfig("pizzaria-demo", configUpdate(first.service, "pizzaria-demo", {
      greeting: "Olá de novo."
    }));
    const restarted = new LocalAttendanceService(new MemoryInboundEventStore(), {
      repository,
      llmAssistant: createLlmAssistant(client, settings()),
      workerIntervalMs: 60_000
    });

    await ask(restarted, "Vocês abrem de noite?", "5511991000010");
    await ask(restarted, "Qual o endereço de vocês?", "5511991000011", "barbearia-demo");

    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstCall = fetcher.mock.calls[0];
    const secondCall = fetcher.mock.calls[1];
    expect(String(firstCall?.[0])).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect((firstCall?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer tenant-secret");
    expect((firstCall?.[1]?.headers as Record<string, string>)["HTTP-Referer"]).toBeUndefined();
    expect(JSON.parse(String(firstCall?.[1]?.body)).model).toBe("llama3");
    expect(String(secondCall?.[0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((secondCall?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer global-secret");
    expect((secondCall?.[1]?.headers as Record<string, string>)["HTTP-Referer"]).toBe("https://example.com");
    expect((secondCall?.[1]?.headers as Record<string, string>)["X-Title"]).toBe("Plataforma de atendimento");
  });

  it("degrades to a plain answer when the local model rejects tools", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) return new Response(JSON.stringify({ error: "tools not supported" }), { status: 400 });
      return completion("Estamos na Rua das Flores, 123.");
    }) as typeof fetch;
    const { service } = createService(
      new OpenAiCompatibleChatClient({ fetcher, sleep: async () => undefined }),
      settings({ provider: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:1.5b", apiKey: "" })
    );

    const result = await ask(service, "Onde fica a loja?", "5511991000020");
    expect(result.conversation.state).toBe("BOT_ACTIVE");
    expect(result.messages.map((message) => message.text)[1]).toBe("Estamos na Rua das Flores, 123.");
    expect(bodies[0]?.tools).toBeDefined();
    expect(bodies[1]?.tools).toBeUndefined();
  });

  it("transfers with the configured message when the model asks for a person or the call times out", async () => {
    const transfer = vi.fn(async () => completion(null, [{
      id: "call-1",
      type: "function",
      function: { name: "transfer_to_human", arguments: "{\"reason\":\"fora da FAQ\"}" }
    }])) as typeof fetch;
    const transferred = await ask(
      createService(new OpenAiCompatibleChatClient({ fetcher: transfer, sleep: async () => undefined })).service,
      "Quero uma informação que não está cadastrada",
      "5511991000030"
    );
    expect(transferred.conversation.state).toBe("WAITING_HUMAN");
    expect(transferred.messages.map((message) => message.text)[1]).toBe("Vou encaminhar você para uma pessoa.");

    const hanging = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    })) as typeof fetch;
    const { service } = createService(
      new OpenAiCompatibleChatClient({ fetcher: hanging, sleep: async () => undefined }),
      settings({ timeoutMs: 30, maxRetries: 1 })
    );
    const timedOut = await ask(service, "Vocês abrem de noite?", "5511991000031");
    expect(timedOut.conversation.state).toBe("WAITING_HUMAN");
    expect(timedOut.messages.map((message) => message.text)[1]).toBe(failureMessage);

    const recovered = await ask(service, "Qual é o endereço?", "5511991000032");
    expect(recovered.conversation.state).toBe("BOT_ACTIVE");
    expect(recovered.messages.map((message) => message.text)[1]).toBe("Estamos na Rua das Flores, 123.");
    expect(hanging).toHaveBeenCalledTimes(2);
  });

  it("does not let an assistant exception stall the next conversation", async () => {
    const assistant: LlmAssistant = {
      failureOutcome: () => ({ kind: "reply_and_handoff", text: failureMessage }),
      completeTurn: async () => { throw new Error("falha privada do provedor"); }
    };
    const store = new MemoryInboundEventStore();
    const service = new LocalAttendanceService(store, { llmAssistant: assistant, workerIntervalMs: 60_000 });

    const failed = await ask(service, "Vocês abrem de noite?", "5511991000040");
    expect(failed.conversation.state).toBe("WAITING_HUMAN");
    expect(failed.messages.map((message) => message.text)[1]).toBe(failureMessage);

    const next = await ask(service, "Qual é o endereço?", "5511991000041");
    expect(next.conversation.state).toBe("BOT_ACTIVE");
    await expect(service.processPending()).resolves.toBeUndefined();
  });

  it("keeps the approved FAQ classifier ahead of the gateway", async () => {
    const selector: KnowledgeAnswerSelector = { selectAnswerIndex: vi.fn().mockResolvedValue(null) };
    const { client, requests } = recordingClient(async () => { throw new Error("não deveria ser chamado"); });
    const { service } = createService(client, settings(), selector);
    service.updateConfig("pizzaria-demo", configUpdate(service, "pizzaria-demo", { assistantMode: "local_ai" }));

    const result = await ask(service, "Vocês abrem de noite?", "5511991000050");
    expect(selector.selectAnswerIndex).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
    expect(result.conversation.state).toBe("WAITING_HUMAN");
    expect(result.messages).toHaveLength(1);
  });

  it("serves a tenant override through the HTTP config route without returning the key", async () => {
    const { client, requests } = recordingClient(async (request) => ({
      ok: true,
      text: `modelo ${request.settings.model}`,
      toolCalls: [],
      toolsDegraded: false
    }));
    const config = { ...testConfig, localDemoEnabled: true, llm: settings() } as AppConfig;
    const app = await buildApp({
      config,
      store: new MemoryInboundEventStore(),
      logger: false,
      llmClient: client
    });
    await app.ready();
    await app.localAttendanceService?.stopWorker();

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@atende.local", password: "AtendeLocal123!" }
    });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0] ?? "";
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const headers = { cookie, "x-csrf-token": csrf };
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/tenants/pizzaria-demo/config",
      headers: { cookie }
    });
    const body = current.json<{ config: UpdateTenantConfigInput }>().config;
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/tenants/pizzaria-demo/config",
      headers,
      payload: { ...body, llm: { provider: "local", model: "llama3", apiKey: "route-secret" } }
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.json())).not.toContain("route-secret");
    expect(saved.json<{ config: { llm?: { model?: string; apiKey?: string } } }>().config.llm).toEqual({ provider: "local", model: "llama3" });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/tenants/pizzaria-demo/simulate",
      headers,
      payload: { customerName: "Cliente", customerPhone: "5511991000060", text: "Vocês abrem de noite?", clientMessageId: "route-llm" }
    });
    expect(accepted.statusCode).toBe(202);
    await app.localAttendanceService?.processPending();
    expect(requests[0]?.settings).toMatchObject({ provider: "local", model: "llama3", apiKey: "route-secret" });
    expect(requests[0]?.settings.baseUrl).toBe("http://127.0.0.1:11434/v1");

    const info = await app.inject({ url: "/api/v1/system/info" });
    expect(JSON.stringify(info.json())).not.toContain("global-secret");
    await app.close();
  });
});
