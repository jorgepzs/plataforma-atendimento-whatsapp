import { describe, expect, it } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { PostgresDatabase } from "../src/infra/postgres/postgres-database.js";
import { PostgresInboundEventStore } from "../src/infra/postgres/postgres-inbound-event-store.js";
import { PostgresRagRepository } from "../src/rag/repository.js";
import { testConfig } from "./helpers.js";

/**
 * Pool PostgreSQL fake em memória para validar o ciclo completo de PostgresDatabase,
 * PostgresInboundEventStore, PostgresRagRepository e buildApp sem depender de daemon externo.
 */
function createInMemoryPgPool() {
  const executedSql: string[] = [];
  const ragChunks = new Map<string, Record<string, unknown>>();
  const inboundEvents: Array<Record<string, unknown>> = [];
  let inboundSeq = 0;
  let tenants: Array<Record<string, unknown>> = [];
  let conversations: Array<Record<string, unknown>> = [];
  let messages: Array<Record<string, unknown>> = [];
  let outbox: Array<Record<string, unknown>> = [];
  let orders: Array<Record<string, unknown>> = [];
  let botSessions: Array<Record<string, unknown>> = [];
  let processedInbound: Array<Record<string, unknown>> = [];
  let users: Array<Record<string, unknown>> = [];
  let memberships: Array<Record<string, unknown>> = [];
  let sessions: Array<Record<string, unknown>> = [];

  const qr = (rows: Array<Record<string, unknown>> = [], rowCount = rows.length): QueryResult => ({
    rows,
    rowCount,
    command: "",
    oid: 0,
    fields: []
  });

  async function runQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    executedSql.push(normalized);

    if (normalized === "SELECT 1") return qr([{ "?column?": 1 }], 1);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(normalized)) return qr([], 0);
    if (normalized.startsWith("UPDATE app_inbound_events") && normalized.includes("WHERE status = 'PROCESSING'")) {
      return qr([], 0);
    }
    if (normalized.startsWith("UPDATE app_inbound_events SET status = 'FAILED'")) {
      return qr([], 0);
    }

    // Hydration SELECTs
    if (normalized.includes("FROM app_attendance_tenants ORDER BY ordinal")) {
      return qr([...tenants]);
    }
    if (normalized.includes("FROM app_attendance_conversations ORDER BY ordinal")) {
      return qr([...conversations]);
    }
    if (normalized.includes("FROM app_attendance_messages ORDER BY ordinal")) {
      return qr([...messages]);
    }
    if (normalized.includes("FROM app_attendance_outbox ORDER BY ordinal")) {
      return qr([...outbox]);
    }
    if (normalized.includes("FROM app_attendance_orders ORDER BY ordinal")) {
      return qr([...orders]);
    }
    if (normalized.includes("FROM app_attendance_bot_sessions ORDER BY ordinal")) {
      return qr([...botSessions]);
    }
    if (normalized.includes("FROM app_attendance_processed_inbound ORDER BY ordinal")) {
      return qr([...processedInbound]);
    }
    if (normalized.includes("FROM app_identity_users ORDER BY ordinal")) {
      return qr([...users]);
    }
    if (normalized.includes("FROM app_identity_memberships ORDER BY user_id")) {
      return qr([...memberships]);
    }
    if (normalized.includes("FROM app_identity_sessions ORDER BY ordinal")) {
      return qr([...sessions]);
    }
    if (
      normalized.startsWith("SELECT * FROM app_consumer_") ||
      normalized.startsWith("SELECT tenant_id, order_id, callback_hash FROM app_consumer_")
    ) {
      return qr([]);
    }

    // Attendance persistence
    if (normalized.includes("DELETE FROM app_attendance_orders")) {
      tenants = [];
      conversations = [];
      messages = [];
      outbox = [];
      orders = [];
      botSessions = [];
      processedInbound = [];
      return qr([]);
    }
    if (normalized.startsWith("INSERT INTO app_attendance_tenants")) {
      tenants.push({
        id: params[0], ordinal: params[1], slug: params[2], display_name: params[3],
        segment: params[4], channel_phone_number_id: params[5], config_json: params[6]
      });
      return qr([], 1);
    }
    if (normalized.startsWith("INSERT INTO app_attendance_conversations")) {
      conversations.push({
        id: params[0], ordinal: params[1], tenant_id: params[2], customer_name: params[3],
        customer_phone: params[4], state: params[5], assigned_user_id: params[6],
        created_at: params[7], updated_at: params[8], last_message_preview: params[9],
        waiting_since: params[10], last_inbound_message_id: params[11], last_inbound_source: params[12],
        last_inbound_phone_number_id: params[13], last_inbound_at: params[14]
      });
      return qr([], 1);
    }
    if (normalized.startsWith("INSERT INTO app_attendance_messages")) {
      messages.push({
        id: params[0], ordinal: params[1], conversation_id: params[2], role: params[3],
        text: params[4], created_at: params[5], delivery_status: params[6],
        delivery_detail: params[7], author_name: params[8], bot_session_id: params[9]
      });
      return qr([], 1);
    }
    if (normalized.startsWith("INSERT INTO app_attendance_outbox")) {
      outbox.push({
        id: params[0], ordinal: params[1], tenant_id: params[2], conversation_id: params[3],
        message_id: params[4], source_inbound_message_id: params[5], source: params[6],
        phone_number_id: params[7], last_inbound_at: params[8], status: params[9],
        blocked_reason: params[10], attempt_count: params[11], provider_message_id: params[12],
        result_code: params[13], created_at: params[14], attempted_at: params[15], completed_at: params[16]
      });
      return qr([], 1);
    }
    if (normalized.startsWith("INSERT INTO app_attendance_bot_sessions")) {
      botSessions.push({ session_json: params[5] });
      return qr([], 1);
    }
    if (normalized.startsWith("INSERT INTO app_attendance_processed_inbound")) {
      processedInbound.push({ event_key: params[0] });
      return qr([], 1);
    }
    if (normalized.startsWith("INSERT INTO app_attendance_orders")) {
      orders.push({ order_json: params[5] });
      return qr([], 1);
    }

    // Identity persistence
    if (normalized.startsWith("DELETE FROM app_identity_sessions")) {
      users = [];
      memberships = [];
      sessions = [];
      return qr([]);
    }
    if (normalized.startsWith("INSERT INTO app_identity_users")) {
      users.push({
        id: params[0], ordinal: params[1], email: params[2], display_name: params[3],
        platform_admin: params[4], salt_hex: params[5], password_hash_hex: params[6]
      });
      return qr([], 1);
    }
    if (normalized.startsWith("INSERT INTO app_identity_memberships")) {
      memberships.push({ user_id: params[0], ordinal: params[1], tenant_id: params[2], role: params[3] });
      return qr([], 1);
    }
    if (normalized.startsWith("INSERT INTO app_identity_sessions")) {
      sessions.push({ token_hash: params[0], ordinal: params[1], user_id: params[2], csrf_token: params[3], expires_at_ms: params[4] });
      return qr([], 1);
    }

    // Inbound events queue
    if (normalized.includes("FROM app_attendance_tenants WHERE channel_phone_number_id = $1")) {
      const phoneId = String(params[0]);
      const match = tenants.some((t) => t.channel_phone_number_id === phoneId || (t.id === "pizzaria-demo" && phoneId === "local-phone-number"));
      return qr(match ? [{ registered: 1 }] : []);
    }
    if (normalized.startsWith("INSERT INTO app_inbound_events")) {
      const exists = inboundEvents.some((e) => e.provider === params[0] && e.provider_event_id === params[1]);
      if (exists) return qr([], 0);
      const id = String(++inboundSeq);
      inboundEvents.push({
        id, provider: params[0], provider_event_id: params[1], provider_phone_number_id: params[2],
        payload_json: params[3], status: "PENDING", attempts: 0, received_at_ms: params[4], next_attempt_at_ms: params[4]
      });
      return qr([{ id }], 1);
    }
    if (normalized.startsWith("SELECT id, payload_json FROM app_inbound_events")) {
      const row = inboundEvents.find((e) => e.status === "PENDING");
      return qr(row ? [row] : []);
    }
    if (normalized.startsWith("UPDATE app_inbound_events SET status = 'PROCESSING'")) {
      const row = inboundEvents.find((e) => e.id === params[1] && e.status === "PENDING");
      if (!row) return qr([], 0);
      row.status = "PROCESSING";
      row.attempts = Number(row.attempts) + 1;
      return qr([], 1);
    }
    if (normalized.startsWith("UPDATE app_inbound_events SET status = 'PROCESSED'")) {
      const row = inboundEvents.find((e) => e.provider === params[1] && e.provider_event_id === params[2] && e.status === "PROCESSING");
      if (row) row.status = "PROCESSED";
      return qr([], row ? 1 : 0);
    }

    // RAG chunks
    if (normalized.includes("FROM rag_knowledge_chunks WHERE tenant_id = $1 ORDER BY")) {
      const rows = [...ragChunks.values()].filter((r) => r.tenant_id === params[0]);
      return qr(rows);
    }
    if (normalized.startsWith("INSERT INTO rag_knowledge_chunks")) {
      ragChunks.set(String(params[0]), {
        id: params[0], tenant_id: params[1], source_kind: params[2], source_key: params[3],
        title: params[4], content: params[5], metadata_json: params[6], content_hash: params[7],
        embedding: params[8], embedding_model: params[9], updated_at: params[10]
      });
      return qr([], 1);
    }
    if (normalized.startsWith("DELETE FROM rag_knowledge_chunks")) {
      const keep = new Set(Array.isArray(params[1]) ? (params[1] as string[]) : []);
      let deleted = 0;
      for (const [id, row] of ragChunks) {
        if (row.tenant_id === params[0] && !keep.has(id)) {
          ragChunks.delete(id);
          deleted += 1;
        }
      }
      return qr([], deleted);
    }
    if (normalized.includes("ts_rank_cd(search_vector")) {
      const needle = String(params[1]).toLowerCase();
      const rows = [...ragChunks.values()]
        .filter((r) => r.tenant_id === params[0] && `${r.title} ${r.content}`.toLowerCase().includes(needle))
        .map((r) => ({ ...r, rank: 0.75 }));
      return qr(rows);
    }

    return qr([]);
  }

  const client = {
    query: runQuery,
    release: () => undefined
  } as unknown as PoolClient;

  const pool = {
    query: runQuery,
    connect: async () => client,
    end: async () => undefined
  } as unknown as Pool;

  return { pool, executedSql, ragChunks, inboundEvents };
}

describe("Unified PostgreSQL backend + RAG", () => {
  it("allows WhatsApp channel in production with DATABASE_URL (PostgreSQL)", () => {
    const prod = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://sou:secret@oracle-pg:5432/sou",
      META_VERIFY_TOKEN: "prod-verify-token",
      META_APP_SECRET: "prod-app-secret",
      WHATSAPP_CHANNEL_ENABLED: "true",
      WHATSAPP_PROVIDER: "unofficial_qr",
      WHATSAPP_SESSION_DIR: "/var/data/whatsapp/sessions",
      LLM_PROVIDER: "openrouter",
      LLM_MODEL: "openai/gpt-4o-mini",
      LLM_API_KEY: "sk-or-prod",
      RAG_EMBEDDING_PROVIDER: "openrouter"
    });
    expect(prod.databaseUrl).toBe("postgresql://sou:secret@oracle-pg:5432/sou");
    expect(prod.whatsapp.enabled).toBe(true);
    expect(prod.rag?.embeddingProvider).toBe("openrouter");
  });

  it("boots attendance, auth, Consumer, inbound queue, and Postgres RAG with an in-memory pool fake, then survives restart", async () => {
    const fake = createInMemoryPgPool();
    const pgDb = await PostgresDatabase.open(fake.pool, { runMigrations: false });
    const store = new PostgresInboundEventStore(pgDb);

    const config: AppConfig = {
      ...testConfig,
      nodeEnv: "development",
      localDemoEnabled: false,
      databaseUrl: "postgresql://sou:secret@127.0.0.1:5432/sou"
    };

    const app = await buildApp({
      config,
      store,
      postgresDatabase: pgDb,
      logger: false
    });

    const info = await app.inject({ url: "/api/v1/system/info" });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      phase: "postgres-attendance",
      eventStore: "postgres",
      attendancePersistence: "postgres",
      rag: { enabled: true, storage: "postgres", embeddingProvider: "none" },
      capabilities: expect.arrayContaining([
        "attendance.postgres.unified",
        "assistant.rag.hybrid"
      ])
    });

    // Authenticate & persist session + simulate inbound message through Postgres queue
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@atende.local", password: "AtendeLocal123!" }
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0] ?? "";
    const csrf = login.json<{ csrfToken: string }>().csrfToken;
    const headers = { cookie, "x-csrf-token": csrf };

    // Sync RAG directly into Postgres rag_knowledge_chunks table
    const cfg = app.localAttendanceService!.getInternalTenantConfig("pizzaria-demo").config;
    const stats = await app.ragService!.syncTenant("pizzaria-demo", cfg);
    expect(stats.indexed).toBeGreaterThan(5);
    expect(fake.ragChunks.size).toBe(stats.indexed);

    // Search PostgresRagRepository lexical FTS path
    const pgRagRepo = new PostgresRagRepository(fake.pool);
    const hits = await pgRagRepo.searchLexical("pizzaria-demo", "calabresa", 5);
    expect(hits.length).toBeGreaterThan(0);

    // Enqueue + process message via PostgresInboundEventStore
    const sim = await app.inject({
      method: "POST",
      url: "/api/v1/tenants/pizzaria-demo/simulate",
      headers,
      payload: { customerName: "Cliente PG", customerPhone: "5511933330001", text: "oi", clientMessageId: "pg-1" }
    });
    expect(sim.statusCode).toBe(202);
    await app.localAttendanceService!.processPending();

    const persistedMessageIndex = fake.executedSql.findIndex((sql) => sql.startsWith("INSERT INTO app_attendance_messages"));
    const acknowledgedEventIndex = fake.executedSql.findIndex((sql) => sql.startsWith("UPDATE app_inbound_events SET status = 'PROCESSED'"));
    expect(persistedMessageIndex).toBeGreaterThan(-1);
    expect(acknowledgedEventIndex).toBeGreaterThan(persistedMessageIndex);

    await app.close();

    // Simulate API restart against the same Postgres pool -> identity, conversation, and bot session survive.
    const pgDbRestarted = await PostgresDatabase.open(fake.pool, { runMigrations: false });
    const storeRestarted = new PostgresInboundEventStore(pgDbRestarted);
    const appRestarted = await buildApp({
      config,
      store: storeRestarted,
      postgresDatabase: pgDbRestarted,
      logger: false
    });

    const me = await appRestarted.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie }
    });
    expect(me.statusCode).toBe(200);

    const convs = appRestarted.localAttendanceService!.listConversations("pizzaria-demo");
    expect(convs).toHaveLength(1);
    expect(convs[0]!.customerPhone).toBe("5511933330001");

    await appRestarted.close();
  });
});
