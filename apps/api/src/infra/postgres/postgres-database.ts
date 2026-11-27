import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import type { AttendanceSnapshot, AttendanceStateRepository } from "../../attendance/types.js";
import type { LocalIdentityRepository, LocalIdentitySnapshot } from "../../auth/local-sessions.js";
import type {
  ConsumerOrderEventRecord,
  ConsumerPartnerConfigRecord,
  ConsumerRepository
} from "../../consumer/repository.js";
import { MAX_INBOUND_ATTEMPTS } from "../sqlite/local-database.js";

const MIGRATION_ADVISORY_LOCK = 20261003;

function defaultMigrationsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../../../migrations");
}

function parseJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

class PostgresAttendanceRepository implements AttendanceStateRepository {
  constructor(private readonly db: PostgresDatabase) {}

  load(): AttendanceSnapshot | undefined {
    return this.db.getAttendanceCache();
  }

  save(snapshot: AttendanceSnapshot): void {
    const cloned = structuredClone(snapshot);
    this.db.setAttendanceCache(cloned);
    this.db.enqueueWrite((client) => this.db.persistAttendanceSnapshot(client, cloned));
  }
}

class PostgresIdentityRepository implements LocalIdentityRepository {
  constructor(private readonly db: PostgresDatabase) {}

  load(): LocalIdentitySnapshot | undefined {
    return this.db.getIdentityCache();
  }

  save(snapshot: LocalIdentitySnapshot): void {
    const cloned = structuredClone(snapshot);
    this.db.setIdentityCache(cloned);
    this.db.enqueueWrite((client) => this.db.persistIdentitySnapshot(client, cloned));
  }
}

class PostgresConsumerRepository implements ConsumerRepository {
  constructor(private readonly db: PostgresDatabase) {}

  getConfig(tenantId: string): ConsumerPartnerConfigRecord | undefined {
    const found = this.db.consumerConfigs.get(tenantId);
    return found ? structuredClone(found) : undefined;
  }

  findEnabledByTokenHash(tokenHash: string): ConsumerPartnerConfigRecord | undefined {
    for (const config of this.db.consumerConfigs.values()) {
      if (config.enabled && config.tokenHash === tokenHash) {
        return structuredClone(config);
      }
    }
    return undefined;
  }

  saveConfig(
    config: Omit<ConsumerPartnerConfigRecord, "tokenHash" | "tokenCreatedAt">,
    tokenHash: string,
    tokenCreatedAt: string
  ): void {
    const saved: ConsumerPartnerConfigRecord = structuredClone({
      ...config,
      tokenHash,
      tokenCreatedAt
    });
    this.db.consumerConfigs.set(saved.tenantId, saved);
    this.db.enqueueWrite(async (client) => {
      await client.query(`
        INSERT INTO app_consumer_partner_configs (
          tenant_id, enabled, enabled_since, public_base_url, merchant_id, merchant_name,
          sales_channel, delivery_fee_received_by, token_hash, token_created_at,
          product_mappings_json, option_mappings_json, variant_choices_json, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)
        ON CONFLICT (tenant_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          enabled_since = EXCLUDED.enabled_since,
          public_base_url = EXCLUDED.public_base_url,
          merchant_id = EXCLUDED.merchant_id,
          merchant_name = EXCLUDED.merchant_name,
          sales_channel = EXCLUDED.sales_channel,
          delivery_fee_received_by = EXCLUDED.delivery_fee_received_by,
          token_hash = EXCLUDED.token_hash,
          token_created_at = EXCLUDED.token_created_at,
          product_mappings_json = EXCLUDED.product_mappings_json,
          option_mappings_json = EXCLUDED.option_mappings_json,
          variant_choices_json = EXCLUDED.variant_choices_json,
          updated_at = EXCLUDED.updated_at
      `, [
        saved.tenantId,
        saved.enabled,
        saved.enabledSince,
        saved.publicBaseUrl,
        saved.merchantId,
        saved.merchantName,
        saved.salesChannel,
        saved.deliveryFeeReceivedBy,
        saved.tokenHash,
        saved.tokenCreatedAt,
        JSON.stringify(saved.productMappings),
        JSON.stringify(saved.optionMappings),
        JSON.stringify(saved.variantChoiceIdsByItemId),
        saved.updatedAt
      ]);
    });
  }

  rotateToken(tenantId: string, tokenHash: string, tokenCreatedAt: string): boolean {
    const existing = this.db.consumerConfigs.get(tenantId);
    if (!existing) return false;
    existing.tokenHash = tokenHash;
    existing.tokenCreatedAt = tokenCreatedAt;
    existing.updatedAt = tokenCreatedAt;
    this.db.enqueueWrite(async (client) => {
      await client.query(`
        UPDATE app_consumer_partner_configs
        SET token_hash = $1, token_created_at = $2, updated_at = $3
        WHERE tenant_id = $4
      `, [tokenHash, tokenCreatedAt, tokenCreatedAt, tenantId]);
    });
    return true;
  }

  saveOrderDetailsContext(tenantId: string, orderId: string, context: unknown, updatedAt: string): void {
    const saved = structuredClone(context);
    this.db.consumerDetailsContexts.set(`${tenantId}:${orderId}`, saved);
    this.db.enqueueWrite(async (client) => {
      await client.query(`
        INSERT INTO app_consumer_order_details_contexts (tenant_id, order_id, context_json, updated_at)
        VALUES ($1,$2,$3::jsonb,$4)
        ON CONFLICT (tenant_id, order_id) DO UPDATE SET
          context_json = EXCLUDED.context_json,
          updated_at = EXCLUDED.updated_at
      `, [tenantId, orderId, JSON.stringify(saved), updatedAt]);
    });
  }

  getOrderDetailsContext<T>(tenantId: string, orderId: string): T | undefined {
    const found = this.db.consumerDetailsContexts.get(`${tenantId}:${orderId}`);
    return found === undefined ? undefined : structuredClone(found) as T;
  }

  ensureOrderEvent(tenantId: string, orderId: string, eventId: string, createdAt: string): ConsumerOrderEventRecord {
    const key = `${tenantId}:${orderId}`;
    const existing = this.db.consumerOrderEvents.get(key);
    if (existing) return { ...existing };
    const created: ConsumerOrderEventRecord = {
      tenantId,
      orderId,
      eventId,
      createdAt,
      detailsRequestedAt: null
    };
    this.db.consumerOrderEvents.set(key, created);
    this.db.enqueueWrite(async (client) => {
      await client.query(`
        INSERT INTO app_consumer_order_events (tenant_id, order_id, event_id, created_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id, order_id) DO NOTHING
      `, [tenantId, orderId, eventId, createdAt]);
    });
    return { ...created };
  }

  getOrderEvent(tenantId: string, orderId: string): ConsumerOrderEventRecord | undefined {
    const found = this.db.consumerOrderEvents.get(`${tenantId}:${orderId}`);
    return found ? { ...found } : undefined;
  }

  markOrderDetailsRequested(tenantId: string, orderId: string, at: string): void {
    const found = this.db.consumerOrderEvents.get(`${tenantId}:${orderId}`);
    if (found && !found.detailsRequestedAt) found.detailsRequestedAt = at;
    this.db.enqueueWrite(async (client) => {
      await client.query(`
        UPDATE app_consumer_order_events
        SET details_requested_at = COALESCE(details_requested_at, $1)
        WHERE tenant_id = $2 AND order_id = $3
      `, [at, tenantId, orderId]);
    });
  }

  listPendingOrderEvents(tenantId: string): ConsumerOrderEventRecord[] {
    return [...this.db.consumerOrderEvents.values()]
      .filter((event) => event.tenantId === tenantId && event.detailsRequestedAt === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.eventId.localeCompare(b.eventId))
      .map((event) => ({ ...event }));
  }

  recordStatusCallback(
    tenantId: string,
    orderId: string,
    callbackHash: string,
    status: string,
    justification: string | undefined,
    receivedAt: string
  ): boolean {
    const key = `${tenantId}:${callbackHash}`;
    if (this.db.consumerCallbacks.has(key)) return false;
    this.db.consumerCallbacks.set(key, { tenantId, orderId, callbackHash });
    this.db.enqueueWrite(async (client) => {
      await client.query(`
        INSERT INTO app_consumer_order_status_callbacks (
          tenant_id, order_id, callback_hash, status, justification, received_at
        ) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id, callback_hash) DO NOTHING
      `, [tenantId, orderId, callbackHash, status, justification ?? null, receivedAt]);
    });
    return true;
  }

  hasStatusCallback(tenantId: string, callbackHash: string): boolean {
    return this.db.consumerCallbacks.has(`${tenantId}:${callbackHash}`);
  }

  countStatusCallbacks(tenantId: string, orderId: string): number {
    let count = 0;
    for (const item of this.db.consumerCallbacks.values()) {
      if (item.tenantId === tenantId && item.orderId === orderId) count += 1;
    }
    return count;
  }
}

export interface PostgresDatabaseOptions {
  migrationsDir?: string;
  runMigrations?: boolean;
  onWriteError?: (error: unknown) => void;
}

/**
 * Camada unificada de persistência PostgreSQL para toda a plataforma.
 * Hidrata estado inicial em memória e serializa gravações transacionais no PostgreSQL,
 * mantendo paridade completa com os repositórios síncronos da aplicação e permitindo
 * acesso SQL assíncrono direto para fila inbound e RAG híbrido.
 */
export class PostgresDatabase {
  readonly pool: Pool;
  readonly attendanceRepository: AttendanceStateRepository;
  readonly identityRepository: LocalIdentityRepository;
  readonly consumerRepository: ConsumerRepository;

  readonly consumerConfigs = new Map<string, ConsumerPartnerConfigRecord>();
  readonly consumerDetailsContexts = new Map<string, unknown>();
  readonly consumerOrderEvents = new Map<string, ConsumerOrderEventRecord>();
  readonly consumerCallbacks = new Map<string, { tenantId: string; orderId: string; callbackHash: string }>();

  private attendanceCache: AttendanceSnapshot | undefined;
  private identityCache: LocalIdentitySnapshot | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly ownPool: boolean;
  private readonly onWriteError: ((error: unknown) => void) | undefined;

  private constructor(pool: Pool, ownPool: boolean, onWriteError?: (error: unknown) => void) {
    this.pool = pool;
    this.ownPool = ownPool;
    this.onWriteError = onWriteError;
    this.attendanceRepository = new PostgresAttendanceRepository(this);
    this.identityRepository = new PostgresIdentityRepository(this);
    this.consumerRepository = new PostgresConsumerRepository(this);
  }

  static async open(
    connection: string | Pool,
    options: PostgresDatabaseOptions = {}
  ): Promise<PostgresDatabase> {
    const ownPool = typeof connection === "string";
    const pool = ownPool
      ? new Pool({
          connectionString: connection,
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000
        })
      : connection;

    const db = new PostgresDatabase(pool, ownPool, options.onWriteError);
    try {
      if (options.runMigrations !== false) {
        await db.applyMigrations(options.migrationsDir ?? defaultMigrationsDir());
      }
      await db.recoverInterruptedState();
      await db.hydrateAll();
      return db;
    } catch (error) {
      if (ownPool) await pool.end().catch(() => undefined);
      throw error;
    }
  }

  getAttendanceCache(): AttendanceSnapshot | undefined {
    return this.attendanceCache ? structuredClone(this.attendanceCache) : undefined;
  }

  setAttendanceCache(snapshot: AttendanceSnapshot): void {
    this.attendanceCache = snapshot;
  }

  getIdentityCache(): LocalIdentitySnapshot | undefined {
    return this.identityCache ? structuredClone(this.identityCache) : undefined;
  }

  setIdentityCache(snapshot: LocalIdentitySnapshot): void {
    this.identityCache = snapshot;
  }

  enqueueWrite(operation: (client: PoolClient) => Promise<void>): void {
    if (this.closed) return;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) return;
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await operation(client);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          this.onWriteError?.(error);
          throw error;
        } finally {
          client.release();
        }
      });
    // Evita unhandledRejection se ninguém aguardar flush() imediatamente.
    this.writeChain.catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  async isReady(): Promise<boolean> {
    if (this.closed) return false;
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush().catch(() => undefined);
    try {
      await this.pool.query(
        `
          UPDATE app_inbound_events
          SET status = CASE WHEN attempts >= $1 THEN 'FAILED' ELSE 'PENDING' END,
              lease_expires_at_ms = NULL
          WHERE status = 'PROCESSING'
        `,
        [MAX_INBOUND_ATTEMPTS]
      );
    } catch {
      // Ignora falha ao liberar leases durante shutdown.
    }
    this.closed = true;
    if (this.ownPool) {
      await this.pool.end();
    }
  }

  private async applyMigrations(migrationsDir: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const filenames = (await readdir(migrationsDir))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const filename of filenames) {
        const applied = await client.query(
          "SELECT 1 FROM schema_migrations WHERE filename = $1",
          [filename]
        );
        if (applied.rowCount) continue;
        const sql = await readFile(path.join(migrationsDir, filename), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK]).catch(() => undefined);
      client.release();
    }
  }

  private async recoverInterruptedState(): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `
        UPDATE app_inbound_events
        SET status = CASE WHEN attempts >= $1 THEN 'FAILED' ELSE 'PENDING' END,
            lease_expires_at_ms = NULL,
            next_attempt_at_ms = LEAST(next_attempt_at_ms, $2::bigint)
        WHERE status = 'PROCESSING'
      `,
      [MAX_INBOUND_ATTEMPTS, now]
    );
  }

  async hydrateAll(): Promise<void> {
    const tenantsRes = await this.pool.query(`
      SELECT id, slug, display_name, segment, channel_phone_number_id, config_json
      FROM app_attendance_tenants ORDER BY ordinal
    `);

    if (tenantsRes.rows.length > 0) {
      const [convRes, msgRes, outboxRes, orderRes, botRes, procRes] = await Promise.all([
        this.pool.query(`
          SELECT id, tenant_id, customer_name, customer_phone, state, assigned_user_id,
            created_at, updated_at, last_message_preview, waiting_since,
            last_inbound_message_id, last_inbound_source, last_inbound_phone_number_id, last_inbound_at
          FROM app_attendance_conversations ORDER BY ordinal
        `),
        this.pool.query(`
          SELECT id, conversation_id, role, text, created_at, delivery_status, delivery_detail, author_name, bot_session_id
          FROM app_attendance_messages ORDER BY ordinal
        `),
        this.pool.query(`
          SELECT id, tenant_id, conversation_id, message_id, source_inbound_message_id, source,
            phone_number_id, last_inbound_at, status, blocked_reason, attempt_count,
            provider_message_id, result_code, created_at, attempted_at, completed_at
          FROM app_attendance_outbox ORDER BY ordinal
        `),
        this.pool.query(`SELECT order_json FROM app_attendance_orders ORDER BY ordinal`),
        this.pool.query(`SELECT session_json FROM app_attendance_bot_sessions ORDER BY ordinal`),
        this.pool.query(`SELECT event_key FROM app_attendance_processed_inbound ORDER BY ordinal`)
      ]);

      const orders = orderRes.rows.map((r) => parseJson<NonNullable<AttendanceSnapshot["orders"]>[number]>(r.order_json));
      const botSessions = botRes.rows.map((r) => parseJson<NonNullable<AttendanceSnapshot["botSessions"]>[number]>(r.session_json));

      this.attendanceCache = {
        tenants: tenantsRes.rows.map((row) => ({
          tenant: {
            id: String(row.id),
            slug: String(row.slug),
            displayName: String(row.display_name),
            segment: String(row.segment) as AttendanceSnapshot["tenants"][number]["tenant"]["segment"],
            channelPhoneNumberId: String(row.channel_phone_number_id)
          },
          config: parseJson<AttendanceSnapshot["tenants"][number]["config"]>(row.config_json)
        })),
        conversations: convRes.rows.map((row) => ({
          id: String(row.id),
          tenantId: String(row.tenant_id),
          customerName: String(row.customer_name),
          customerPhone: String(row.customer_phone),
          state: String(row.state) as AttendanceSnapshot["conversations"][number]["state"],
          assignedUserId: row.assigned_user_id === null ? null : String(row.assigned_user_id),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
          lastMessagePreview: String(row.last_message_preview),
          waitingSince: row.waiting_since === null ? null : String(row.waiting_since),
          lastInboundMessageId: row.last_inbound_message_id === null ? null : String(row.last_inbound_message_id),
          lastInboundSource: row.last_inbound_source === null ? null : String(row.last_inbound_source) as AttendanceSnapshot["conversations"][number]["lastInboundSource"],
          lastInboundPhoneNumberId: row.last_inbound_phone_number_id === null ? null : String(row.last_inbound_phone_number_id),
          lastInboundAt: row.last_inbound_at === null ? null : String(row.last_inbound_at)
        })),
        messages: msgRes.rows.map((row) => ({
          id: String(row.id),
          conversationId: String(row.conversation_id),
          role: String(row.role) as AttendanceSnapshot["messages"][number]["role"],
          text: String(row.text),
          createdAt: String(row.created_at),
          deliveryStatus: String(row.delivery_status) as AttendanceSnapshot["messages"][number]["deliveryStatus"],
          ...(row.delivery_detail ? { deliveryDetail: String(row.delivery_detail) } : {}),
          authorName: row.author_name === null ? null : String(row.author_name),
          ...(row.bot_session_id === null ? {} : { botSessionId: String(row.bot_session_id) })
        })),
        outbox: outboxRes.rows.map((row) => ({
          id: String(row.id),
          tenantId: String(row.tenant_id),
          conversationId: String(row.conversation_id),
          messageId: String(row.message_id),
          sourceInboundMessageId: row.source_inbound_message_id === null ? null : String(row.source_inbound_message_id),
          source: row.source === null ? null : String(row.source) as AttendanceSnapshot["outbox"][number]["source"],
          phoneNumberId: row.phone_number_id === null ? null : String(row.phone_number_id),
          lastInboundAt: row.last_inbound_at === null ? null : String(row.last_inbound_at),
          status: String(row.status) as AttendanceSnapshot["outbox"][number]["status"],
          blockedReason: row.blocked_reason === null ? null : String(row.blocked_reason) as AttendanceSnapshot["outbox"][number]["blockedReason"],
          attemptCount: Number(row.attempt_count),
          providerMessageId: row.provider_message_id === null ? null : String(row.provider_message_id),
          resultCode: row.result_code === null ? null : String(row.result_code),
          createdAt: String(row.created_at),
          attemptedAt: row.attempted_at === null ? null : String(row.attempted_at),
          completedAt: row.completed_at === null ? null : String(row.completed_at)
        })),
        ...(orders.length > 0 ? { orders } : {}),
        ...(botSessions.length > 0 ? { botSessions } : {}),
        processedInboundIds: procRes.rows.map((r) => String(r.event_key))
      };
    } else {
      this.attendanceCache = undefined;
    }

    const usersRes = await this.pool.query(`
      SELECT id, email, display_name, platform_admin, salt_hex, password_hash_hex
      FROM app_identity_users ORDER BY ordinal
    `);
    if (usersRes.rows.length > 0) {
      const [memRes, sessRes] = await Promise.all([
        this.pool.query(`SELECT user_id, tenant_id, role FROM app_identity_memberships ORDER BY user_id, ordinal`),
        this.pool.query(`SELECT token_hash, user_id, csrf_token, expires_at_ms FROM app_identity_sessions ORDER BY ordinal`)
      ]);
      const memByUser = new Map<string, LocalIdentitySnapshot["users"][number]["memberships"]>();
      for (const row of memRes.rows) {
        const uid = String(row.user_id);
        const list = memByUser.get(uid) ?? [];
        list.push({ tenantId: String(row.tenant_id), role: String(row.role) as "TENANT_ADMIN" | "ATTENDANT" });
        memByUser.set(uid, list);
      }
      this.identityCache = {
        users: usersRes.rows.map((row) => ({
          id: String(row.id),
          email: String(row.email),
          displayName: String(row.display_name),
          platformAdmin: Boolean(row.platform_admin),
          memberships: memByUser.get(String(row.id)) ?? [],
          saltHex: String(row.salt_hex),
          passwordHashHex: String(row.password_hash_hex)
        })),
        sessions: sessRes.rows.map((row) => ({
          tokenHash: String(row.token_hash),
          userId: String(row.user_id),
          csrfToken: String(row.csrf_token),
          expiresAtMs: Number(row.expires_at_ms)
        }))
      };
    } else {
      this.identityCache = undefined;
    }

    // Consumer caches
    this.consumerConfigs.clear();
    this.consumerDetailsContexts.clear();
    this.consumerOrderEvents.clear();
    this.consumerCallbacks.clear();
    const [cCfgRes, cCtxRes, cEvtRes, cCbRes] = await Promise.all([
      this.pool.query(`SELECT * FROM app_consumer_partner_configs`),
      this.pool.query(`SELECT * FROM app_consumer_order_details_contexts`),
      this.pool.query(`SELECT * FROM app_consumer_order_events`),
      this.pool.query(`SELECT tenant_id, order_id, callback_hash FROM app_consumer_order_status_callbacks`)
    ]);
    for (const row of cCfgRes.rows) {
      this.consumerConfigs.set(String(row.tenant_id), {
        tenantId: String(row.tenant_id),
        enabled: Boolean(row.enabled),
        enabledSince: row.enabled_since === null ? null : String(row.enabled_since),
        publicBaseUrl: String(row.public_base_url),
        merchantId: String(row.merchant_id),
        merchantName: String(row.merchant_name),
        salesChannel: row.sales_channel === null ? null : String(row.sales_channel),
        deliveryFeeReceivedBy: row.delivery_fee_received_by === null
          ? null
          : String(row.delivery_fee_received_by) as "MERCHANT" | "PARTNER",
        tokenHash: String(row.token_hash),
        tokenCreatedAt: String(row.token_created_at),
        productMappings: parseJson(row.product_mappings_json),
        optionMappings: parseJson(row.option_mappings_json),
        variantChoiceIdsByItemId: parseJson(row.variant_choices_json),
        updatedAt: String(row.updated_at)
      });
    }
    for (const row of cCtxRes.rows) {
      this.consumerDetailsContexts.set(`${row.tenant_id}:${row.order_id}`, parseJson(row.context_json));
    }
    for (const row of cEvtRes.rows) {
      this.consumerOrderEvents.set(`${row.tenant_id}:${row.order_id}`, {
        tenantId: String(row.tenant_id),
        orderId: String(row.order_id),
        eventId: String(row.event_id),
        createdAt: String(row.created_at),
        detailsRequestedAt: row.details_requested_at === null ? null : String(row.details_requested_at)
      });
    }
    for (const row of cCbRes.rows) {
      this.consumerCallbacks.set(`${row.tenant_id}:${row.callback_hash}`, {
        tenantId: String(row.tenant_id),
        orderId: String(row.order_id),
        callbackHash: String(row.callback_hash)
      });
    }
  }

  async persistAttendanceSnapshot(client: PoolClient, snapshot: AttendanceSnapshot): Promise<void> {
    await client.query(`
      DELETE FROM app_attendance_orders;
      DELETE FROM app_attendance_bot_sessions;
      DELETE FROM app_attendance_outbox;
      DELETE FROM app_attendance_processed_inbound;
      DELETE FROM app_attendance_conversations;
      DELETE FROM app_attendance_tenants;
    `);

    for (let i = 0; i < snapshot.tenants.length; i += 1) {
      const { tenant, config } = snapshot.tenants[i]!;
      await client.query(`
        INSERT INTO app_attendance_tenants
          (id, ordinal, slug, display_name, segment, channel_phone_number_id, config_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      `, [tenant.id, i, tenant.slug, tenant.displayName, tenant.segment, tenant.channelPhoneNumberId, JSON.stringify(config)]);
    }

    for (let i = 0; i < snapshot.conversations.length; i += 1) {
      const c = snapshot.conversations[i]!;
      await client.query(`
        INSERT INTO app_attendance_conversations
          (id, ordinal, tenant_id, customer_name, customer_phone, state, assigned_user_id,
           created_at, updated_at, last_message_preview, waiting_since, last_inbound_message_id,
           last_inbound_source, last_inbound_phone_number_id, last_inbound_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [
        c.id, i, c.tenantId, c.customerName, c.customerPhone, c.state, c.assignedUserId,
        c.createdAt, c.updatedAt, c.lastMessagePreview, c.waitingSince, c.lastInboundMessageId,
        c.lastInboundSource, c.lastInboundPhoneNumberId, c.lastInboundAt
      ]);
    }

    const botSessions = snapshot.botSessions ?? [];
    for (let i = 0; i < botSessions.length; i += 1) {
      const s = botSessions[i]!;
      await client.query(`
        INSERT INTO app_attendance_bot_sessions
          (id, ordinal, tenant_id, conversation_id, customer_phone, session_json)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      `, [s.id, i, s.tenantId, s.conversationId, s.customerPhone, JSON.stringify(s)]);
    }

    for (let i = 0; i < snapshot.messages.length; i += 1) {
      const m = snapshot.messages[i]!;
      await client.query(`
        INSERT INTO app_attendance_messages
          (id, ordinal, conversation_id, role, text, created_at, delivery_status, delivery_detail, author_name, bot_session_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [m.id, i, m.conversationId, m.role, m.text, m.createdAt, m.deliveryStatus, m.deliveryDetail ?? null, m.authorName, m.botSessionId ?? null]);
    }

    for (let i = 0; i < snapshot.outbox.length; i += 1) {
      const o = snapshot.outbox[i]!;
      await client.query(`
        INSERT INTO app_attendance_outbox
          (id, ordinal, tenant_id, conversation_id, message_id, source_inbound_message_id, source,
           phone_number_id, last_inbound_at, status, blocked_reason, attempt_count,
           provider_message_id, result_code, created_at, attempted_at, completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      `, [
        o.id, i, o.tenantId, o.conversationId, o.messageId, o.sourceInboundMessageId, o.source,
        o.phoneNumberId, o.lastInboundAt, o.status, o.blockedReason, o.attemptCount,
        o.providerMessageId, o.resultCode, o.createdAt, o.attemptedAt, o.completedAt
      ]);
    }

    for (let i = 0; i < snapshot.processedInboundIds.length; i += 1) {
      await client.query(
        `INSERT INTO app_attendance_processed_inbound (event_key, ordinal) VALUES ($1,$2)`,
        [snapshot.processedInboundIds[i]!, i]
      );
    }

    const orders = snapshot.orders ?? [];
    for (let i = 0; i < orders.length; i += 1) {
      const ord = orders[i]!;
      await client.query(`
        INSERT INTO app_attendance_orders (id, ordinal, tenant_id, conversation_id, status, order_json)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      `, [ord.id, i, ord.tenantId, ord.conversationId, ord.status, JSON.stringify(ord)]);
    }
  }

  async persistIdentitySnapshot(client: PoolClient, snapshot: LocalIdentitySnapshot): Promise<void> {
    await client.query(`DELETE FROM app_identity_sessions; DELETE FROM app_identity_users;`);
    for (let i = 0; i < snapshot.users.length; i += 1) {
      const u = snapshot.users[i]!;
      await client.query(`
        INSERT INTO app_identity_users (id, ordinal, email, display_name, platform_admin, salt_hex, password_hash_hex)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [u.id, i, u.email, u.displayName, u.platformAdmin, u.saltHex.toLowerCase(), u.passwordHashHex.toLowerCase()]);
      for (let m = 0; m < u.memberships.length; m += 1) {
        const mem = u.memberships[m]!;
        await client.query(`
          INSERT INTO app_identity_memberships (user_id, ordinal, tenant_id, role)
          VALUES ($1,$2,$3,$4)
        `, [u.id, m, mem.tenantId, mem.role]);
      }
    }
    for (let i = 0; i < snapshot.sessions.length; i += 1) {
      const s = snapshot.sessions[i]!;
      await client.query(`
        INSERT INTO app_identity_sessions (token_hash, ordinal, user_id, csrf_token, expires_at_ms)
        VALUES ($1,$2,$3,$4,$5)
      `, [s.tokenHash.toLowerCase(), i, s.userId, s.csrfToken, s.expiresAtMs]);
    }
  }
}
