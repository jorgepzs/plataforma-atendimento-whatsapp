import type { Pool } from "pg";
import type { SqliteLocalDatabase } from "../infra/sqlite/local-database.js";
import type { RagChunk, RagSourceKind } from "./types.js";

export interface RagLexicalHit {
  chunk: RagChunk;
  rank: number;
}

export interface RagRepository {
  listChunks(tenantId: string): Promise<RagChunk[]>;
  upsertChunks(chunks: readonly RagChunk[]): Promise<void>;
  deleteMissingChunks(tenantId: string, keepIds: readonly string[]): Promise<number>;
  searchLexical(tenantId: string, query: string, limit: number): Promise<RagLexicalHit[]>;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function parseEmbedding(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  try {
    const raw = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(raw)) return null;
    const embedding = raw.map((item) => Number(item));
    return embedding.every(Number.isFinite) ? embedding : null;
  } catch {
    return null;
  }
}

function mapPgChunk(row: Record<string, unknown>): RagChunk {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    sourceKind: String(row.source_kind) as RagSourceKind,
    sourceKey: String(row.source_key),
    title: String(row.title),
    content: String(row.content),
    metadata: parseJsonObject(row.metadata_json),
    contentHash: String(row.content_hash),
    embedding: parseEmbedding(row.embedding),
    embeddingModel: row.embedding_model === null ? null : String(row.embedding_model),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

function mapSqliteChunk(row: Record<string, unknown>): RagChunk {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    sourceKind: String(row.source_kind) as RagSourceKind,
    sourceKey: String(row.source_key),
    title: String(row.title),
    content: String(row.content),
    metadata: parseJsonObject(row.metadata_json),
    contentHash: String(row.content_hash),
    embedding: parseEmbedding(row.embedding_json),
    embeddingModel: row.embedding_model === null ? null : String(row.embedding_model),
    updatedAt: String(row.updated_at)
  };
}

export class SqliteRagRepository implements RagRepository {
  constructor(private readonly database: SqliteLocalDatabase) {}

  async listChunks(tenantId: string): Promise<RagChunk[]> {
    const rows = this.database.connection.prepare(`
      SELECT id, tenant_id, source_kind, source_key, title, content,
        metadata_json, content_hash, embedding_json, embedding_model, updated_at
      FROM rag_knowledge_chunks
      WHERE tenant_id = ?
      ORDER BY source_kind, source_key
    `).all(tenantId) as Record<string, unknown>[];
    return rows.map(mapSqliteChunk);
  }

  async upsertChunks(chunks: readonly RagChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    this.database.transaction(() => {
      const statement = this.database.connection.prepare(`
        INSERT INTO rag_knowledge_chunks (
          id, tenant_id, source_kind, source_key, title, content,
          metadata_json, content_hash, embedding_json, embedding_model, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          metadata_json = excluded.metadata_json,
          content_hash = excluded.content_hash,
          embedding_json = excluded.embedding_json,
          embedding_model = excluded.embedding_model,
          updated_at = excluded.updated_at
      `);
      for (const chunk of chunks) {
        statement.run(
          chunk.id,
          chunk.tenantId,
          chunk.sourceKind,
          chunk.sourceKey,
          chunk.title,
          chunk.content,
          JSON.stringify(chunk.metadata),
          chunk.contentHash,
          chunk.embedding ? JSON.stringify(chunk.embedding) : null,
          chunk.embeddingModel,
          chunk.updatedAt
        );
      }
    });
  }

  async deleteMissingChunks(tenantId: string, keepIds: readonly string[]): Promise<number> {
    if (keepIds.length === 0) {
      const result = this.database.connection.prepare(
        "DELETE FROM rag_knowledge_chunks WHERE tenant_id = ?"
      ).run(tenantId);
      return Number(result.changes);
    }
    const placeholders = keepIds.map(() => "?").join(", ");
    const result = this.database.connection.prepare(`
      DELETE FROM rag_knowledge_chunks
      WHERE tenant_id = ? AND id NOT IN (${placeholders})
    `).run(tenantId, ...keepIds);
    return Number(result.changes);
  }

  async searchLexical(): Promise<RagLexicalHit[]> {
    // A busca lexical determinística é calculada em TenantRagService sobre os chunks persistidos.
    return [];
  }
}

export class PostgresRagRepository implements RagRepository {
  constructor(private readonly pool: Pool) {}

  async listChunks(tenantId: string): Promise<RagChunk[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `
        SELECT id, tenant_id, source_kind, source_key, title, content,
          metadata_json, content_hash, embedding, embedding_model, updated_at
        FROM rag_knowledge_chunks
        WHERE tenant_id = $1
        ORDER BY source_kind, source_key
      `,
      [tenantId]
    );
    return res.rows.map(mapPgChunk);
  }

  async upsertChunks(chunks: readonly RagChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const chunk of chunks) {
        await client.query(
          `
            INSERT INTO rag_knowledge_chunks (
              id, tenant_id, source_kind, source_key, title, content,
              metadata_json, content_hash, embedding, embedding_model, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11::timestamptz)
            ON CONFLICT (id) DO UPDATE SET
              title = EXCLUDED.title,
              content = EXCLUDED.content,
              metadata_json = EXCLUDED.metadata_json,
              content_hash = EXCLUDED.content_hash,
              embedding = EXCLUDED.embedding,
              embedding_model = EXCLUDED.embedding_model,
              updated_at = EXCLUDED.updated_at
          `,
          [
            chunk.id,
            chunk.tenantId,
            chunk.sourceKind,
            chunk.sourceKey,
            chunk.title,
            chunk.content,
            JSON.stringify(chunk.metadata),
            chunk.contentHash,
            chunk.embedding ? JSON.stringify(chunk.embedding) : null,
            chunk.embeddingModel,
            chunk.updatedAt
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteMissingChunks(tenantId: string, keepIds: readonly string[]): Promise<number> {
    if (keepIds.length === 0) {
      const res = await this.pool.query(
        `DELETE FROM rag_knowledge_chunks WHERE tenant_id = $1`,
        [tenantId]
      );
      return res.rowCount ?? 0;
    }
    const res = await this.pool.query(
      `DELETE FROM rag_knowledge_chunks WHERE tenant_id = $1 AND NOT (id = ANY($2::text[]))`,
      [tenantId, keepIds]
    );
    return res.rowCount ?? 0;
  }

  async searchLexical(tenantId: string, query: string, limit: number): Promise<RagLexicalHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    try {
      const res = await this.pool.query<Record<string, unknown>>(
        `
          SELECT id, tenant_id, source_kind, source_key, title, content,
            metadata_json, content_hash, embedding, embedding_model, updated_at,
            ts_rank_cd(search_vector, websearch_to_tsquery('portuguese', $2)) AS rank
          FROM rag_knowledge_chunks
          WHERE tenant_id = $1
            AND search_vector @@ websearch_to_tsquery('portuguese', $2)
          ORDER BY rank DESC
          LIMIT $3
        `,
        [tenantId, trimmed, limit]
      );
      return res.rows.map((row) => ({
        chunk: mapPgChunk(row),
        rank: Number(row.rank ?? 0)
      }));
    } catch {
      return [];
    }
  }
}

export class MemoryRagRepository implements RagRepository {
  private readonly chunks = new Map<string, RagChunk>();

  async listChunks(tenantId: string): Promise<RagChunk[]> {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.tenantId === tenantId)
      .sort((a, b) => a.sourceKind.localeCompare(b.sourceKind) || a.sourceKey.localeCompare(b.sourceKey))
      .map((chunk) => ({
        ...chunk,
        metadata: { ...chunk.metadata },
        embedding: chunk.embedding ? [...chunk.embedding] : null
      }));
  }

  async upsertChunks(chunks: readonly RagChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, {
        ...chunk,
        metadata: { ...chunk.metadata },
        embedding: chunk.embedding ? [...chunk.embedding] : null
      });
    }
  }

  async deleteMissingChunks(tenantId: string, keepIds: readonly string[]): Promise<number> {
    const keep = new Set(keepIds);
    let deleted = 0;
    for (const [id, chunk] of this.chunks) {
      if (chunk.tenantId === tenantId && !keep.has(id)) {
        this.chunks.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async searchLexical(): Promise<RagLexicalHit[]> {
    // No modo memória, o TenantRagService aplica o ranqueamento BM25/tokenizado diretamente.
    return [];
  }
}
