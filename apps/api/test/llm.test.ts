import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { OpenAiCompatibleChatClient } from "../src/llm/openai-chat-client.js";
import {
  chatCompletionsUrl,
  resolveLlmSettings,
  type LlmSettings
} from "../src/llm/settings.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function settings(overrides: Omit<Partial<LlmSettings>, "apiKey"> & { apiKey?: string } = {}): LlmSettings {
  const { apiKey = "sk-test", ...rest } = overrides;
  const resolved: LlmSettings = {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    timeoutMs: 1_000,
    maxRetries: 0,
    httpReferer: "https://example.com",
    appTitle: "Plataforma de atendimento",
    failureMessage: "Não consegui responder agora. Vou transferir você para uma pessoa.",
    failureAction: "reply_and_handoff",
    supportsTools: true,
    ...rest
  };
  if (apiKey) resolved.apiKey = apiKey;
  return resolved;
}

function completion(content: string | null, toolCalls?: unknown[], status = 200): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {})
      }
    }]
  }), { status, headers: { "content-type": "application/json" } });
}

describe("LLM provider selection", () => {
  const base = settings();

  it("keeps the global provider and replaces only the tenant fields that were set", () => {
    expect(resolveLlmSettings(base, { model: "anthropic/claude-3.5-sonnet", apiKey: "tenant-key" })).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
      apiKey: "tenant-key",
      httpReferer: "https://example.com"
    });
  });

  it("switches a tenant to the local provider without keeping the remote key or URL", () => {
    const resolved = resolveLlmSettings(base, {
      provider: "local",
      model: "qwen2.5:1.5b",
      baseUrl: "http://127.0.0.1:1234/v1",
      supportsTools: false
    });
    expect(resolved).toMatchObject({
      provider: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen2.5:1.5b",
      supportsTools: false
    });
    expect(resolved.apiKey).toBeUndefined();
    expect(chatCompletionsUrl(resolved.baseUrl)).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(chatCompletionsUrl("http://127.0.0.1:11434/v1/chat/completions")).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });
});

describe("OpenAI-compatible chat client", () => {
  it("calls OpenRouter with the recommended headers", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      url = String(input);
      init = requestInit;
      return completion("A pizzaria abre às 18h.");
    }) as typeof fetch;
    const client = new OpenAiCompatibleChatClient({ fetcher, sleep: async () => undefined });

    await expect(client.complete({
      settings: settings(),
      messages: [{ role: "user", content: "Qual o horário?" }],
      tools: [{ name: "transfer_to_human", description: "Transfere", parameters: { type: "object" } }]
    })).resolves.toMatchObject({ ok: true, text: "A pizzaria abre às 18h.", toolsDegraded: false });

    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean; tools: unknown[] };
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    expect(headers["X-Title"]).toBe("Plataforma de atendimento");
    expect(body).toMatchObject({ model: "openai/gpt-4o-mini", stream: false });
    expect(body.tools).toHaveLength(1);
  });

  it("calls a local endpoint without OpenRouter headers or authorization", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      url = String(input);
      init = requestInit;
      return completion("Resposta local.");
    }) as typeof fetch;
    const client = new OpenAiCompatibleChatClient({ fetcher, sleep: async () => undefined });
    const local = settings({
      provider: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:1.5b",
      apiKey: ""
    });

    await expect(client.complete({
      settings: local,
      messages: [{ role: "user", content: "Oi" }]
    })).resolves.toMatchObject({ ok: true, text: "Resposta local." });

    const headers = init?.headers as Record<string, string>;
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(headers.authorization).toBeUndefined();
    expect(headers["HTTP-Referer"]).toBeUndefined();
    expect(headers["X-Title"]).toBeUndefined();
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("tools");
  });

  it("retries a request that the model rejects because of tools and then uses the plain answer", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, requestInit?: RequestInit) => {
      const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "tools are not supported by this model" } }), { status: 400 });
      }
      return completion("Atendemos das 9h às 18h.");
    }) as typeof fetch;
    const client = new OpenAiCompatibleChatClient({ fetcher, sleep: async () => undefined });

    await expect(client.complete({
      settings: settings({ provider: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:1.5b" }),
      messages: [{ role: "user", content: "Horário?" }],
      tools: [{ name: "transfer_to_human", description: "Transfere", parameters: { type: "object" } }]
    })).resolves.toMatchObject({ ok: true, text: "Atendemos das 9h às 18h.", toolsDegraded: true, toolCalls: [] });

    expect(bodies[0]?.tools).toBeDefined();
    expect(bodies[1]?.tools).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not send tools when the provider is configured without them", async () => {
    let body: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, requestInit?: RequestInit) => {
      body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
      return completion("Resposta simples.");
    }) as typeof fetch;
    const client = new OpenAiCompatibleChatClient({ fetcher, sleep: async () => undefined });

    await expect(client.complete({
      settings: settings({ supportsTools: false }),
      messages: [{ role: "user", content: "Oi" }],
      tools: [{ name: "transfer_to_human", description: "Transfere", parameters: { type: "object" } }]
    })).resolves.toMatchObject({ ok: true, text: "Resposta simples.", toolCalls: [] });
    expect(body?.tools).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a transient HTTP failure and stops on authentication failure", async () => {
    let attempts = 0;
    const transient = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return new Response("busy", { status: 503 });
      return completion("ok");
    }) as typeof fetch;
    const client = new OpenAiCompatibleChatClient({ fetcher: transient, sleep: async () => undefined });
    await expect(client.complete({
      settings: settings({ maxRetries: 1 }),
      messages: [{ role: "user", content: "Oi" }]
    })).resolves.toMatchObject({ ok: true, text: "ok" });
    expect(transient).toHaveBeenCalledTimes(2);

    const unauthorized = vi.fn(async () => new Response("nope", { status: 401 })) as typeof fetch;
    const denied = new OpenAiCompatibleChatClient({ fetcher: unauthorized, sleep: async () => undefined });
    await expect(denied.complete({
      settings: settings({ maxRetries: 2 }),
      messages: [{ role: "user", content: "Oi" }]
    })).resolves.toMatchObject({ ok: false, reason: "http", statusCode: 401 });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("returns a timeout result after the configured attempts instead of throwing", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    })) as typeof fetch;
    const client = new OpenAiCompatibleChatClient({ fetcher, sleep: async () => undefined });

    await expect(client.complete({
      settings: settings({ timeoutMs: 30, maxRetries: 1 }),
      messages: [{ role: "user", content: "Oi" }]
    })).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reads a tool call that transfers the conversation", async () => {
    const fetcher = vi.fn(async () => completion(null, [{
      id: "call-1",
      type: "function",
      function: { name: "transfer_to_human", arguments: "{\"reason\":\"sem resposta\"}" }
    }])) as typeof fetch;
    const client = new OpenAiCompatibleChatClient({ fetcher, sleep: async () => undefined });
    await expect(client.complete({
      settings: settings(),
      messages: [{ role: "user", content: "Quero algo fora da FAQ" }],
      tools: [{ name: "transfer_to_human", description: "Transfere", parameters: { type: "object" } }]
    })).resolves.toMatchObject({
      ok: true,
      toolCalls: [{ name: "transfer_to_human", arguments: { reason: "sem resposta" } }]
    });
  });
});

describe("app boot by provider", () => {
  async function boot(environment: NodeJS.ProcessEnv) {
    const config = loadConfig(environment);
    const app = await buildApp({ config, store: new MemoryInboundEventStore(), logger: false });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await app.inject({ url: "/api/v1/system/info" });
    return response.json<Record<string, unknown>>();
  }

  it("starts with OpenRouter or a local provider by changing only the environment", async () => {
    const secret = "sk-boot-secret";
    const openrouter = await boot({
      NODE_ENV: "development",
      API_HOST: "127.0.0.1",
      LLM_PROVIDER: "openrouter",
      LLM_API_KEY: secret,
      LLM_MODEL: "openai/gpt-4o-mini"
    });
    expect(openrouter).toMatchObject({
      llm: { enabled: true, provider: "openrouter", model: "openai/gpt-4o-mini" },
      capabilities: expect.arrayContaining(["assistant.llm.gateway"])
    });
    expect(JSON.stringify(openrouter)).not.toContain(secret);

    const local = await boot({
      NODE_ENV: "production",
      API_HOST: "0.0.0.0",
      DATABASE_URL: "postgresql://sou:secret@localhost:5432/sou",
      META_VERIFY_TOKEN: "production-token",
      META_APP_SECRET: "production-app-secret",
      LLM_PROVIDER: "local",
      LLM_BASE_URL: "http://host.docker.internal:11434/v1",
      LLM_MODEL: "qwen2.5:1.5b"
    });
    expect(local).toMatchObject({
      llm: { enabled: true, provider: "local", model: "qwen2.5:1.5b" },
      localDemoEnabled: false
    });
    expect(JSON.stringify(local)).not.toContain("host.docker.internal");
  });
});
