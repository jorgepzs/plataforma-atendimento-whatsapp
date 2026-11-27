export interface EmbeddingClient {
  readonly model: string;
  embed(texts: readonly string[]): Promise<number[][] | null>;
}

export interface OpenAiCompatibleEmbeddingClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  httpReferer?: string;
  appTitle?: string;
  fetcher?: typeof fetch;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly httpReferer: string | undefined;
  private readonly appTitle: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: OpenAiCompatibleEmbeddingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.httpReferer = options.httpReferer;
    this.appTitle = options.appTitle;
    this.fetcher = options.fetcher ?? fetch;
  }

  async embed(texts: readonly string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json"
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.httpReferer) headers["HTTP-Referer"] = this.httpReferer;
    if (this.appTitle) headers["X-Title"] = this.appTitle;

    try {
      const response = await this.fetcher(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          input: texts
        }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        data?: Array<{ index?: number; embedding?: unknown }>;
      };
      if (!Array.isArray(body.data) || body.data.length !== texts.length) return null;
      const ordered = [...body.data].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
      const vectors: number[][] = [];
      for (const entry of ordered) {
        if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) return null;
        const vec = entry.embedding.map((value) => Number(value));
        if (vec.some((value) => !Number.isFinite(value))) return null;
        vectors.push(vec);
      }
      return vectors;
    } catch {
      return null;
    }
  }
}
