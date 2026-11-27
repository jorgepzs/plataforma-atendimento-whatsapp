export type RagSourceKind = "profile" | "policy" | "faq" | "catalog_item";

export type RagEmbeddingProvider = "none" | "openrouter" | "local";

export interface RagSettings {
  enabled: boolean;
  embeddingProvider: RagEmbeddingProvider;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  topKCatalog: number;
  topKKnowledge: number;
  timeoutMs: number;
}

export interface RagChunk {
  id: string;
  tenantId: string;
  sourceKind: RagSourceKind;
  sourceKey: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  updatedAt: string;
}

export interface RagRetrievedKnowledgeChunk {
  sourceKind: "profile" | "policy" | "faq";
  title: string;
  content: string;
  score: number;
}

export interface RagRetrievedContext {
  knowledgeChunks: RagRetrievedKnowledgeChunk[];
  catalogItemIds: string[];
  catalogCategoriesSummary: string;
  totalIndexedChunks: number;
  mode: "hybrid_vector_lexical" | "lexical";
}

export interface RagSyncStats {
  indexed: number;
  unchanged: number;
  deleted: number;
  embedded: number;
}
