import type { SqliteLocalDatabase } from "../infra/sqlite/local-database.js";

export interface ConsumerProductMapping {
  itemId: string;
  choiceIds: string[];
  externalCode: string;
}

export interface ConsumerOptionMapping {
  choiceId: string;
  externalCode: string;
}

export interface ConsumerPartnerConfigRecord {
  tenantId: string;
  enabled: boolean;
  enabledSince: string | null;
  publicBaseUrl: string;
  merchantId: string;
  merchantName: string;
  salesChannel: string | null;
  deliveryFeeReceivedBy: "MERCHANT" | "PARTNER" | null;
  tokenHash: string;
  tokenCreatedAt: string;
  productMappings: ConsumerProductMapping[];
  optionMappings: ConsumerOptionMapping[];
  variantChoiceIdsByItemId: Record<string, string[]>;
  updatedAt: string;
}

export interface ConsumerOrderEventRecord {
  tenantId: string;
  orderId: string;
  eventId: string;
  createdAt: string;
  detailsRequestedAt: string | null;
}

export interface ConsumerRepository {
  getConfig(tenantId: string): ConsumerPartnerConfigRecord | undefined;
  findEnabledByTokenHash(tokenHash: string): ConsumerPartnerConfigRecord | undefined;
  saveConfig(config: Omit<ConsumerPartnerConfigRecord, "tokenHash" | "tokenCreatedAt">, tokenHash: string, tokenCreatedAt: string): void;
  rotateToken(tenantId: string, tokenHash: string, tokenCreatedAt: string): boolean;
  saveOrderDetailsContext(tenantId: string, orderId: string, context: unknown, updatedAt: string): void;
  getOrderDetailsContext<T>(tenantId: string, orderId: string): T | undefined;
  ensureOrderEvent(tenantId: string, orderId: string, eventId: string, createdAt: string): ConsumerOrderEventRecord;
  getOrderEvent(tenantId: string, orderId: string): ConsumerOrderEventRecord | undefined;
  markOrderDetailsRequested(tenantId: string, orderId: string, at: string): void;
  listPendingOrderEvents(tenantId: string): ConsumerOrderEventRecord[];
  recordStatusCallback(tenantId: string, orderId: string, callbackHash: string, status: string, justification: string | undefined, receivedAt: string): boolean;
  hasStatusCallback(tenantId: string, callbackHash: string): boolean;
  countStatusCallbacks(tenantId: string, orderId: string): number;
}

function readConfig(row: Record<string, unknown> | undefined): ConsumerPartnerConfigRecord | undefined {
  if (!row) return undefined;
  return {
    tenantId: String(row.tenant_id),
    enabled: Number(row.enabled) === 1,
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
    productMappings: JSON.parse(String(row.product_mappings_json)) as ConsumerProductMapping[],
    optionMappings: JSON.parse(String(row.option_mappings_json)) as ConsumerOptionMapping[],
    variantChoiceIdsByItemId: JSON.parse(String(row.variant_choices_json)) as Record<string, string[]>,
    updatedAt: String(row.updated_at)
  };
}

export class SqliteConsumerRepository implements ConsumerRepository {
  constructor(private readonly database: SqliteLocalDatabase) {}

  getConfig(tenantId: string): ConsumerPartnerConfigRecord | undefined {
    return readConfig(this.database.prepare(`
      SELECT tenant_id, enabled, enabled_since, public_base_url, merchant_id, merchant_name, sales_channel,
        delivery_fee_received_by, token_hash, token_created_at, product_mappings_json,
        option_mappings_json, variant_choices_json, updated_at
      FROM consumer_partner_configs WHERE tenant_id = ?
    `).get(tenantId) as Record<string, unknown> | undefined);
  }

  findEnabledByTokenHash(tokenHash: string): ConsumerPartnerConfigRecord | undefined {
    const config = readConfig(this.database.prepare(`
      SELECT tenant_id, enabled, enabled_since, public_base_url, merchant_id, merchant_name, sales_channel,
        delivery_fee_received_by, token_hash, token_created_at, product_mappings_json,
        option_mappings_json, variant_choices_json, updated_at
      FROM consumer_partner_configs WHERE token_hash = ? AND enabled = 1
    `).get(tokenHash) as Record<string, unknown> | undefined);
    return config;
  }

  saveConfig(config: Omit<ConsumerPartnerConfigRecord, "tokenHash" | "tokenCreatedAt">, tokenHash: string, tokenCreatedAt: string): void {
    this.database.prepare(`
      INSERT INTO consumer_partner_configs (
        tenant_id, enabled, enabled_since, public_base_url, merchant_id, merchant_name, sales_channel,
        delivery_fee_received_by, token_hash, token_created_at, product_mappings_json,
        option_mappings_json, variant_choices_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        enabled = excluded.enabled,
        enabled_since = excluded.enabled_since,
        public_base_url = excluded.public_base_url,
        merchant_id = excluded.merchant_id,
        merchant_name = excluded.merchant_name,
        sales_channel = excluded.sales_channel,
        delivery_fee_received_by = excluded.delivery_fee_received_by,
        token_hash = excluded.token_hash,
        token_created_at = excluded.token_created_at,
        product_mappings_json = excluded.product_mappings_json,
        option_mappings_json = excluded.option_mappings_json,
        variant_choices_json = excluded.variant_choices_json,
        updated_at = excluded.updated_at
    `).run(
      config.tenantId,
      config.enabled ? 1 : 0,
      config.enabledSince,
      config.publicBaseUrl,
      config.merchantId,
      config.merchantName,
      config.salesChannel,
      config.deliveryFeeReceivedBy,
      tokenHash,
      tokenCreatedAt,
      JSON.stringify(config.productMappings),
      JSON.stringify(config.optionMappings),
      JSON.stringify(config.variantChoiceIdsByItemId),
      config.updatedAt
    );
  }

  rotateToken(tenantId: string, tokenHash: string, tokenCreatedAt: string): boolean {
    const result = this.database.prepare(`
      UPDATE consumer_partner_configs SET token_hash = ?, token_created_at = ?, updated_at = ?
      WHERE tenant_id = ?
    `).run(tokenHash, tokenCreatedAt, tokenCreatedAt, tenantId);
    return Number(result.changes) === 1;
  }

  saveOrderDetailsContext(tenantId: string, orderId: string, context: unknown, updatedAt: string): void {
    this.database.prepare(`
      INSERT INTO consumer_order_details_contexts (tenant_id, order_id, context_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, order_id) DO UPDATE SET
        context_json = excluded.context_json,
        updated_at = excluded.updated_at
    `).run(tenantId, orderId, JSON.stringify(context), updatedAt);
  }

  getOrderDetailsContext<T>(tenantId: string, orderId: string): T | undefined {
    const row = this.database.prepare(`
      SELECT context_json FROM consumer_order_details_contexts WHERE tenant_id = ? AND order_id = ?
    `).get(tenantId, orderId) as { context_json: string } | undefined;
    return row ? JSON.parse(row.context_json) as T : undefined;
  }

  ensureOrderEvent(tenantId: string, orderId: string, eventId: string, createdAt: string): ConsumerOrderEventRecord {
    this.database.prepare(`
      INSERT OR IGNORE INTO consumer_order_events (tenant_id, order_id, event_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(tenantId, orderId, eventId, createdAt);
    return this.getOrderEvent(tenantId, orderId)!;
  }

  getOrderEvent(tenantId: string, orderId: string): ConsumerOrderEventRecord | undefined {
    const row = this.database.prepare(`
      SELECT tenant_id, order_id, event_id, created_at, details_requested_at
      FROM consumer_order_events WHERE tenant_id = ? AND order_id = ?
    `).get(tenantId, orderId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      tenantId: String(row.tenant_id),
      orderId: String(row.order_id),
      eventId: String(row.event_id),
      createdAt: String(row.created_at),
      detailsRequestedAt: row.details_requested_at === null ? null : String(row.details_requested_at)
    };
  }

  markOrderDetailsRequested(tenantId: string, orderId: string, at: string): void {
    this.database.prepare(`
      UPDATE consumer_order_events SET details_requested_at = COALESCE(details_requested_at, ?)
      WHERE tenant_id = ? AND order_id = ?
    `).run(at, tenantId, orderId);
  }

  listPendingOrderEvents(tenantId: string): ConsumerOrderEventRecord[] {
    const rows = this.database.prepare(`
      SELECT tenant_id, order_id, event_id, created_at, details_requested_at
      FROM consumer_order_events
      WHERE tenant_id = ? AND details_requested_at IS NULL
      ORDER BY created_at, event_id
    `).all(tenantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      tenantId: String(row.tenant_id),
      orderId: String(row.order_id),
      eventId: String(row.event_id),
      createdAt: String(row.created_at),
      detailsRequestedAt: null
    }));
  }

  recordStatusCallback(tenantId: string, orderId: string, callbackHash: string, status: string, justification: string | undefined, receivedAt: string): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO consumer_order_status_callbacks
        (tenant_id, order_id, callback_hash, status, justification, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tenantId, orderId, callbackHash, status, justification ?? null, receivedAt);
    return Number(result.changes) === 1;
  }

  hasStatusCallback(tenantId: string, callbackHash: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS present FROM consumer_order_status_callbacks WHERE tenant_id = ? AND callback_hash = ?
    `).get(tenantId, callbackHash));
  }

  countStatusCallbacks(tenantId: string, orderId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM consumer_order_status_callbacks WHERE tenant_id = ? AND order_id = ?
    `).get(tenantId, orderId) as { count: number };
    return Number(row.count);
  }
}
