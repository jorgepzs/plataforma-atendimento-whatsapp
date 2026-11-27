import type { TenantConfig } from "../attendance/types.js";
import type { CustomerOrder } from "../ordering/types.js";
import { buildTenantRagChunks, normalizeRagText, summarizeCatalogCategories, tokenizeRagText } from "./chunker.js";
import { cosineSimilarity, type EmbeddingClient } from "./embeddings.js";
import type { RagRepository } from "./repository.js";
import type { RagChunk, RagRetrievedContext, RagRetrievedKnowledgeChunk, RagSettings, RagSyncStats } from "./types.js";

export interface TenantRagServiceOptions {
  repository: RagRepository;
  settings: RagSettings;
  embeddingClient?: EmbeddingClient;
  now?: () => Date;
}

function lexicalScore(queryNormalized: string, queryTokens: readonly string[], chunk: RagChunk): number {
  if (queryTokens.length === 0) return 0;
  const titleNorm = normalizeRagText(chunk.title);
  const contentNorm = normalizeRagText(chunk.content);
  const titleTokens = new Set(tokenizeRagText(chunk.title));
  const contentTokens = new Set(tokenizeRagText(chunk.content));

  let score = 0;
  if (queryNormalized.length >= 3 && titleNorm.includes(queryNormalized)) {
    score += 4.0;
  } else if (queryNormalized.length >= 4 && contentNorm.includes(queryNormalized)) {
    score += 2.5;
  }

  let matchedTokens = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      score += 2.0;
      matchedTokens += 1;
      continue;
    }
    if (contentTokens.has(token)) {
      score += 1.2;
      matchedTokens += 1;
      continue;
    }
    // Prefixo de 4+ caracteres captura plurais/radicais e abreviações ("calab" -> "calabresa", "refri" -> "refrigerante").
    if (token.length >= 4) {
      if (titleNorm.includes(token)) {
        score += 1.3;
        matchedTokens += 1;
      } else if (contentNorm.includes(token)) {
        score += 0.8;
        matchedTokens += 1;
      }
    }
  }

  if (matchedTokens > 0) {
    score += (matchedTokens / queryTokens.length) * 1.5;
  }
  return score;
}

export class TenantRagService {
  private readonly repository: RagRepository;
  private readonly settings: RagSettings;
  private readonly embeddingClient: EmbeddingClient | undefined;
  private readonly now: () => Date;
  private readonly inflightSync = new Map<string, Promise<RagSyncStats>>();

  constructor(options: TenantRagServiceOptions) {
    this.repository = options.repository;
    this.settings = options.settings;
    this.embeddingClient = options.embeddingClient;
    this.now = options.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  syncTenant(tenantId: string, config: TenantConfig): Promise<RagSyncStats> {
    const running = this.inflightSync.get(tenantId);
    if (running) return running;
    const task = this.executeSync(tenantId, config).finally(() => {
      if (this.inflightSync.get(tenantId) === task) {
        this.inflightSync.delete(tenantId);
      }
    });
    this.inflightSync.set(tenantId, task);
    return task;
  }

  private async executeSync(tenantId: string, config: TenantConfig): Promise<RagSyncStats> {
    const desired = buildTenantRagChunks(tenantId, config);
    const existing = await this.repository.listChunks(tenantId);
    const existingById = new Map(existing.map((chunk) => [chunk.id, chunk]));
    const targetModel = this.embeddingClient?.model ?? null;

    const toUpsert: typeof desired = [];
    let unchanged = 0;

    for (const chunk of desired) {
      const prev = existingById.get(chunk.id);
      const sameContent = prev && prev.contentHash === chunk.contentHash;
      const sameEmbedding = !targetModel || (prev?.embedding !== null && prev?.embeddingModel === targetModel);
      if (sameContent && sameEmbedding) {
        unchanged += 1;
        continue;
      }
      toUpsert.push(chunk);
    }

    let embeddings: number[][] | null = null;
    if (toUpsert.length > 0 && this.embeddingClient) {
      embeddings = await this.embeddingClient.embed(
        toUpsert.map((chunk) => `${chunk.title}\n${chunk.content}`)
      );
    }

    const nowIso = this.now().toISOString();
    const records: RagChunk[] = toUpsert.map((chunk, idx) => ({
      ...chunk,
      embedding: embeddings?.[idx] ?? null,
      embeddingModel: embeddings?.[idx] ? targetModel : null,
      updatedAt: nowIso
    }));

    await this.repository.upsertChunks(records);
    const deleted = await this.repository.deleteMissingChunks(
      tenantId,
      desired.map((chunk) => chunk.id)
    );

    return {
      indexed: records.length,
      unchanged,
      deleted,
      embedded: embeddings ? embeddings.length : 0
    };
  }

  async retrieve(input: {
    tenantId: string;
    query: string;
    config: TenantConfig;
    openOrder?: CustomerOrder | null;
  }): Promise<RagRetrievedContext> {
    let chunks = await this.repository.listChunks(input.tenantId);
    if (chunks.length === 0) {
      await this.syncTenant(input.tenantId, input.config);
      chunks = await this.repository.listChunks(input.tenantId);
    }

    const queryNormalized = normalizeRagText(input.query);
    const queryTokens = tokenizeRagText(input.query);

    const [ftsHits, queryEmbedding] = await Promise.all([
      this.repository.searchLexical(input.tenantId, input.query, Math.max(20, this.settings.topKCatalog + this.settings.topKKnowledge)),
      this.embeddingClient && chunks.some((chunk) => chunk.embedding !== null)
        ? this.embeddingClient.embed([input.query]).then((vecs) => vecs?.[0] ?? null)
        : Promise.resolve(null)
    ]);

    const ftsRankById = new Map<string, number>();
    for (const hit of ftsHits) {
      ftsRankById.set(hit.chunk.id, hit.rank);
    }

    const usedVector = Boolean(queryEmbedding);
    const scored = chunks.map((chunk) => {
      const lex = lexicalScore(queryNormalized, queryTokens, chunk);
      const fts = (ftsRankById.get(chunk.id) ?? 0) * 6.0;
      const vec = queryEmbedding && chunk.embedding
        ? Math.max(0, cosineSimilarity(queryEmbedding, chunk.embedding)) * 5.0
        : 0;
      return {
        chunk,
        score: lex + fts + vec
      };
    });

    const knowledgeCandidates = scored
      .filter((entry) => entry.chunk.sourceKind === "faq" || entry.chunk.sourceKind === "policy")
      .sort((a, b) => b.score - a.score);

    const selectedKnowledge: RagRetrievedKnowledgeChunk[] = knowledgeCandidates
      .filter((entry) => entry.score > 0)
      .slice(0, this.settings.topKKnowledge)
      .map((entry) => ({
        sourceKind: entry.chunk.sourceKind as "faq" | "policy",
        title: entry.chunk.title,
        content: entry.chunk.content,
        score: Number(entry.score.toFixed(4))
      }));

    const orderItemIds = new Set((input.openOrder?.lines ?? []).map((line) => line.itemId));
    const catalogCandidates = scored
      .filter((entry) => entry.chunk.sourceKind === "catalog_item")
      .sort((a, b) => b.score - a.score);

    const selectedCatalogIds: string[] = [];
    const seenIds = new Set<string>();
    const pushItemId = (id: string) => {
      if (!id || seenIds.has(id)) return;
      seenIds.add(id);
      selectedCatalogIds.push(id);
    };

    // Itens já presentes no carrinho em aberto têm prioridade absoluta.
    for (const itemId of orderItemIds) {
      pushItemId(itemId);
    }

    for (const entry of catalogCandidates) {
      if (selectedCatalogIds.length >= this.settings.topKCatalog) break;
      if (entry.score <= 0) break;
      const itemId = typeof entry.chunk.metadata.itemId === "string"
        ? entry.chunk.metadata.itemId
        : entry.chunk.sourceKey;
      pushItemId(itemId);
    }

    return {
      knowledgeChunks: selectedKnowledge,
      catalogItemIds: selectedCatalogIds,
      catalogCategoriesSummary: summarizeCatalogCategories(input.config.catalog),
      totalIndexedChunks: chunks.length,
      mode: usedVector ? "hybrid_vector_lexical" : "lexical"
    };
  }
}
