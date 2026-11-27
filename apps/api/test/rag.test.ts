import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalAttendanceService } from "../src/attendance/service.js";
import type { TenantConfig } from "../src/attendance/types.js";
import { loadConfig } from "../src/config.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { SqliteLocalDatabase } from "../src/infra/sqlite/local-database.js";
import { createLlmAssistant, type LlmChatClient, type LlmChatRequest } from "../src/llm/index.js";
import type { LlmSettings } from "../src/llm/settings.js";
import { buildSystemPrompt } from "../src/ordering/prompt.js";
import { pizzariaCatalog, pizzariaProfile } from "../src/ordering/seed.js";
import type { CatalogItem, CustomerOrder } from "../src/ordering/types.js";
import {
  buildTenantRagChunks,
  cosineSimilarity,
  MemoryRagRepository,
  OpenAiCompatibleEmbeddingClient,
  SqliteRagRepository,
  summarizeCatalogCategories,
  TenantRagService,
  type EmbeddingClient
} from "../src/rag/index.js";

function largeCatalog(): CatalogItem[] {
  const items: CatalogItem[] = [...pizzariaCatalog];
  for (let i = 1; i <= 40; i += 1) {
    items.push({
      id: `esfiha-${i}`,
      name: `Esfiha Especial ${i}`,
      description: `Recheio artesanal número ${i} assado na hora.`,
      priceCents: 900 + i * 50,
      category: "Esfihas",
      available: true,
      optionGroups: []
    });
  }
  return items;
}

function largeConfig(): TenantConfig {
  const knowledge = Array.from({ length: 25 }, (_, i) => ({
    question: `Pergunta frequente ${i + 1} sobre tema ${i + 1}`,
    answer: `Resposta oficial detalhada número ${i + 1} com instruções do negócio.`
  }));
  knowledge.push({
    question: "Vocês possuem opção sem glúten?",
    answer: "Temos massa sem glúten sob encomenda com acréscimo informado no balcão."
  });
  return {
    businessName: "Pizzaria Grande",
    segment: "pizzaria",
    assistantObjective: "Ajudar o cliente a escolher no cardápio e montar pedidos.",
    greeting: "Olá!",
    knowledge,
    handoffKeywords: ["atendente", "humano"],
    assistantMode: "approved_faq",
    version: 1,
    profile: { ...pizzariaProfile },
    catalog: largeCatalog(),
    orderingEnabled: true
  };
}

function llmSettings(): LlmSettings {
  return {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    apiKey: "sk-test-rag",
    timeoutMs: 2_000,
    maxRetries: 0,
    httpReferer: "https://example.com",
    appTitle: "Atende",
    failureMessage: "Não consegui responder agora. Vou transferir você para uma pessoa.",
    failureAction: "reply_and_handoff",
    supportsTools: true
  };
}

describe("Hybrid RAG", () => {
  it("parses RAG environment settings and inherits LLM_API_KEY for openrouter embeddings", () => {
    const def = loadConfig({ NODE_ENV: "development" });
    expect(def.rag).toMatchObject({
      enabled: true,
      embeddingProvider: "none",
      topKCatalog: 8,
      topKKnowledge: 5
    });

    const or = loadConfig({
      NODE_ENV: "development",
      LLM_PROVIDER: "openrouter",
      LLM_MODEL: "openai/gpt-4o-mini",
      LLM_API_KEY: "sk-or-inherited",
      RAG_EMBEDDING_PROVIDER: "openrouter",
      RAG_TOP_K_CATALOG: "6",
      RAG_TOP_K_KNOWLEDGE: "4"
    });
    expect(or.rag).toMatchObject({
      enabled: true,
      embeddingProvider: "openrouter",
      embeddingBaseUrl: "https://openrouter.ai/api/v1",
      embeddingModel: "openai/text-embedding-3-small",
      embeddingApiKey: "sk-or-inherited",
      topKCatalog: 6,
      topKKnowledge: 4
    });

    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        RAG_EMBEDDING_PROVIDER: "openrouter"
      })
    ).toThrow(/RAG_EMBEDDING_API_KEY/);
  });

  it("diffs chunks via SHA-256 so unchanged chunks skip embedding calls and removed items are pruned", async () => {
    const repo = new MemoryRagRepository();
    const embedMock = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0, 0]));
    const embeddingClient: EmbeddingClient = {
      model: "openai/text-embedding-3-small",
      embed: embedMock
    };
    const rag = new TenantRagService({
      repository: repo,
      settings: {
        enabled: true,
        embeddingProvider: "openrouter",
        embeddingModel: "openai/text-embedding-3-small",
        topKCatalog: 6,
        topKKnowledge: 4,
        timeoutMs: 2_000
      },
      embeddingClient
    });

    const cfg = largeConfig();
    const first = await rag.syncTenant("pizzaria-demo", cfg);
    expect(first.indexed).toBe(buildTenantRagChunks("pizzaria-demo", cfg).length);
    expect(first.unchanged).toBe(0);
    expect(first.embedded).toBe(first.indexed);
    expect(embedMock).toHaveBeenCalledTimes(1);

    // Second sync with identical config performs 0 embedding calls
    const second = await rag.syncTenant("pizzaria-demo", cfg);
    expect(second.indexed).toBe(0);
    expect(second.unchanged).toBe(first.indexed);
    expect(second.embedded).toBe(0);
    expect(embedMock).toHaveBeenCalledTimes(1);

    // Remove 10 esfihas and edit 1 FAQ -> embeds only the 1 changed FAQ and prunes the 10 removed chunks
    const shrunk: TenantConfig = {
      ...cfg,
      catalog: cfg.catalog.slice(0, cfg.catalog.length - 10),
      knowledge: cfg.knowledge.map((entry, idx) =>
        idx === 0 ? { ...entry, answer: "Resposta atualizada." } : entry
      )
    };
    const third = await rag.syncTenant("pizzaria-demo", shrunk);
    expect(third.indexed).toBe(1);
    expect(third.deleted).toBe(10);
    expect(third.embedded).toBe(1);
    expect(embedMock).toHaveBeenCalledTimes(2);
  });

  it("retrieves compact top-K catalog & FAQ chunks, keeps openOrder items, and shrinks prompt size dramatically", async () => {
    const repo = new MemoryRagRepository();
    const rag = new TenantRagService({
      repository: repo,
      settings: {
        enabled: true,
        embeddingProvider: "none",
        topKCatalog: 5,
        topKKnowledge: 3,
        timeoutMs: 2_000
      }
    });

    const cfg = largeConfig();
    const openOrder: CustomerOrder = {
      id: "ord-open",
      tenantId: "pizzaria-demo",
      conversationId: "conv-1",
      status: "draft",
      lines: [
        {
          lineId: "l-1",
          itemId: "coca-2l",
          name: "Coca-Cola 2 litros",
          quantity: 1,
          unitPriceCents: 1400,
          choices: [],
          lineTotalCents: 1400
        }
      ],
      fulfillment: null,
      subtotalCents: 1400,
      deliveryFeeCents: 0,
      totalCents: 1400,
      currency: "BRL",
      summaryPresentedAt: null,
      confirmedAt: null,
      cancelledAt: null,
      integrationReference: null,
      integrationError: null,
      createdAt: "2026-11-27T10:00:00.000Z",
      updatedAt: "2026-11-27T10:00:00.000Z"
    };

    const retrieved = await rag.retrieve({
      tenantId: "pizzaria-demo",
      query: "Vocês têm massa sem glúten e pizza calabresa?",
      config: cfg,
      openOrder
    });

    expect(retrieved.mode).toBe("lexical");
    expect(retrieved.catalogItemIds.length).toBeLessThanOrEqual(5);
    expect(retrieved.catalogItemIds).toContain("coca-2l"); // preserved from openOrder!
    expect(retrieved.catalogItemIds).toContain("calabresa");
    expect(retrieved.knowledgeChunks.some((c) => c.content.includes("sem glúten"))).toBe(true);
    expect(retrieved.catalogCategoriesSummary).toBe(summarizeCatalogCategories(cfg.catalog));

    const fullPrompt = buildSystemPrompt({
      businessName: cfg.businessName,
      segment: cfg.segment,
      assistantObjective: cfg.assistantObjective,
      knowledge: cfg.knowledge,
      profile: cfg.profile,
      catalog: cfg.catalog,
      orderingEnabled: cfg.orderingEnabled,
      order: openOrder
    })!;
    const ragPrompt = buildSystemPrompt({
      businessName: cfg.businessName,
      segment: cfg.segment,
      assistantObjective: cfg.assistantObjective,
      knowledge: cfg.knowledge,
      profile: cfg.profile,
      catalog: cfg.catalog,
      orderingEnabled: cfg.orderingEnabled,
      order: openOrder,
      rag: retrieved
    })!;

    expect(ragPrompt.length).toBeLessThan(fullPrompt.length * 0.6);
    expect(ragPrompt).toContain("Categorias disponíveis no cardápio:");
    expect(ragPrompt).toContain("Pizza Calabresa");
    expect(ragPrompt).toContain("Coca-Cola 2 litros");
    expect(ragPrompt).not.toContain("Esfiha Especial 39");
  });

  it("omits unrelated FAQ and catalog chunks when the query has no lexical or vector match", async () => {
    const config = largeConfig();
    const rag = new TenantRagService({
      repository: new MemoryRagRepository(),
      settings: {
        enabled: true,
        embeddingProvider: "none",
        topKCatalog: 8,
        topKKnowledge: 5,
        timeoutMs: 2_000
      }
    });

    const retrieved = await rag.retrieve({
      tenantId: "pizzaria-demo",
      query: "xyzqv 92741 assunto inexistente",
      config
    });

    expect(retrieved.knowledgeChunks).toEqual([]);
    expect(retrieved.catalogItemIds).toEqual([]);
    expect(retrieved.catalogCategoriesSummary).toBe(summarizeCatalogCategories(config.catalog));
  });

  it("combines vector similarity with lexical search and fails closed if embedding endpoint fails", async () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);

    const failingClient = new OpenAiCompatibleEmbeddingClient({
      baseUrl: "https://embeddings.invalid/v1",
      model: "openai/text-embedding-3-small",
      apiKey: "sk-test",
      fetcher: (async () => new Response("error", { status: 503 })) as typeof fetch
    });
    expect(await failingClient.embed(["teste"])).toBeNull();

    const repo = new MemoryRagRepository();
    const semanticClient: EmbeddingClient = {
      model: "test-embed",
      async embed(texts) {
        return texts.map((text) => {
          if (/glúten|celíaco/i.test(text)) return [1, 0];
          return [0, 1];
        });
      }
    };
    const rag = new TenantRagService({
      repository: repo,
      settings: {
        enabled: true,
        embeddingProvider: "openrouter",
        embeddingModel: "test-embed",
        topKCatalog: 4,
        topKKnowledge: 2,
        timeoutMs: 2_000
      },
      embeddingClient: semanticClient
    });

    const cfg = largeConfig();
    await rag.syncTenant("pizzaria-demo", cfg);
    // Query uses "celíaco" (synonym not present literally in FAQ text) -> vector score finds "sem glúten"!
    const res = await rag.retrieve({
      tenantId: "pizzaria-demo",
      query: "Sou celíaco, posso comer aí?",
      config: cfg
    });
    expect(res.mode).toBe("hybrid_vector_lexical");
    expect(res.knowledgeChunks[0]?.content).toContain("sem glúten");
  });

  it("persists SQLite RAG chunks and embeddings across database restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atende-rag-sqlite-"));
    const databasePath = join(directory, "knowledge.sqlite");
    let database = new SqliteLocalDatabase(databasePath);
    try {
      const cfg = largeConfig();
      const repository = new SqliteRagRepository(database);
      const embeddingClient: EmbeddingClient = {
        model: "test-persistent-embedding",
        async embed(texts) {
          return texts.map((text) => /sem glúten|celíaco/i.test(text) ? [1, 0] : [0, 1]);
        }
      };
      const firstService = new TenantRagService({
        repository,
        settings: {
          enabled: true,
          embeddingProvider: "local",
          embeddingModel: embeddingClient.model,
          topKCatalog: 4,
          topKKnowledge: 2,
          timeoutMs: 2_000
        },
        embeddingClient
      });
      const indexed = await firstService.syncTenant("tenant-persistente", cfg);
      expect(indexed.embedded).toBeGreaterThan(0);
      expect((await repository.listChunks("tenant-persistente")).every((chunk) => chunk.embedding !== null)).toBe(true);
      database.close();

      database = new SqliteLocalDatabase(databasePath);
      const restartedRepository = new SqliteRagRepository(database);
      const restartedService = new TenantRagService({
        repository: restartedRepository,
        settings: {
          enabled: true,
          embeddingProvider: "local",
          embeddingModel: embeddingClient.model,
          topKCatalog: 4,
          topKKnowledge: 2,
          timeoutMs: 2_000
        },
        embeddingClient
      });
      const retrieved = await restartedService.retrieve({
        tenantId: "tenant-persistente",
        query: "Sou celíaco, posso comer aí?",
        config: cfg
      });
      expect(retrieved.totalIndexedChunks).toBe(indexed.embedded);
      expect(retrieved.mode).toBe("hybrid_vector_lexical");
      expect(retrieved.knowledgeChunks[0]?.content).toContain("sem glúten");
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("injects RAG context into LocalAttendanceService LLM turns while keeping full catalog price validation", async () => {
    const requests: LlmChatRequest[] = [];
    const client: LlmChatClient = {
      async complete(request) {
        requests.push(request);
        return {
          ok: true,
          text: "Temos Pizza Calabresa a partir de R$ 48,00 e também Esfiha Especial 35 por R$ 26,50.",
          toolCalls: [],
          toolsDegraded: false
        };
      }
    };
    const rag = new TenantRagService({
      repository: new MemoryRagRepository(),
      settings: {
        enabled: true,
        embeddingProvider: "none",
        topKCatalog: 3,
        topKKnowledge: 2,
        timeoutMs: 2_000
      }
    });
    const service = new LocalAttendanceService(new MemoryInboundEventStore(), {
      llmAssistant: createLlmAssistant(client, llmSettings()),
      ragService: rag,
      workerIntervalMs: 60_000
    });

    const current = service.getConfig("pizzaria-demo").config;
    service.updateConfig("pizzaria-demo", {
      ...current,
      catalog: largeCatalog(),
      orderingEnabled: true
    });

    await service.simulateMessage("pizzaria-demo", {
      customerName: "Cliente",
      customerPhone: "5511944440001",
      text: "Qual o preço da calabresa?",
      clientMessageId: "rag-turn-1"
    });
    await service.processPending();

    expect(requests).toHaveLength(1);
    const systemPrompt = requests[0]!.messages[0]!.content;
    expect(systemPrompt).toContain("Categorias disponíveis no cardápio:");
    expect(systemPrompt).toContain("Pizza Calabresa");
    expect(systemPrompt).not.toContain("Esfiha Especial 35");

    // Price of Esfiha Especial 35 (2650 cents = R$ 26,50) is still allowed by guardAssistantOutput because full catalog is passed to guardrails!
    const conv = service.listConversations("pizzaria-demo")[0]!;
    const messages = service.getConversation("pizzaria-demo", conv.id).messages;
    expect(messages.at(-1)?.role).toBe("BOT");
    expect(messages.at(-1)?.text).toContain("R$ 26,50");
  });
});
