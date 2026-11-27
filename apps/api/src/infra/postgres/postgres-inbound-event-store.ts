import { Pool } from "pg";
import type { PendingInboundEventStore } from "../../attendance/types.js";
import type { NormalizedInboundMessage } from "../../meta/inbound-message.js";
import type { EnqueueInboundResult, InboundEventStore } from "../../ports/inbound-event-store.js";
import {
  INBOUND_BACKOFF_BASE_MS,
  INBOUND_BACKOFF_MAX_MS,
  INBOUND_LEASE_MS,
  MAX_INBOUND_ATTEMPTS
} from "../sqlite/local-database.js";
import type { PostgresDatabase } from "./postgres-database.js";

interface EnqueueQueryResult {
  channel_count: number;
  inserted_count: number;
}

interface PendingEventRow {
  id: string;
  payload_json: unknown;
}

function deserialize(payload: unknown): NormalizedInboundMessage {
  const event = (typeof payload === "string" ? JSON.parse(payload) : payload) as Partial<NormalizedInboundMessage> & {
    provider: "META_WHATSAPP";
    providerEventId: string;
    providerPhoneNumberId: string;
    consumerPhoneNumber: string;
    occurredAt: string;
    type: NormalizedInboundMessage["type"];
    rawMessage: Record<string, unknown>;
  };
  const source = event.source ?? (event.rawMessage?.source === "local-simulator" ? "LOCAL_SIMULATOR" : "LEGACY_UNKNOWN");
  return { ...event, source, occurredAt: new Date(event.occurredAt) } as NormalizedInboundMessage;
}

function retryDelay(attempt: number): number {
  return Math.min(INBOUND_BACKOFF_BASE_MS * (2 ** Math.max(0, attempt - 1)), INBOUND_BACKOFF_MAX_MS);
}

export class PostgresInboundEventStore implements InboundEventStore, PendingInboundEventStore {
  readonly kind = "postgres" as const;
  readonly database: PostgresDatabase | undefined;
  private readonly pool: Pool;

  constructor(poolOrDatabase: Pool | PostgresDatabase) {
    if ("pool" in poolOrDatabase && "attendanceRepository" in poolOrDatabase) {
      this.database = poolOrDatabase;
      this.pool = poolOrDatabase.pool;
    } else {
      this.pool = poolOrDatabase;
    }
  }

  async enqueue(message: NormalizedInboundMessage): Promise<EnqueueInboundResult> {
    if (this.database) {
      await this.database.flush();
      return this.enqueueUnified(message);
    }
    return this.enqueueLegacyWebhookOnly(message);
  }

  private async enqueueUnified(message: NormalizedInboundMessage): Promise<EnqueueInboundResult> {
    const occurredAt = message.occurredAt;
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
      throw new Error("Evento inbound com occurredAt inválido.");
    }
    const timestamp = Date.now();
    const channelRes = await this.pool.query<{ registered: number }>(
      `
        SELECT 1 AS registered FROM app_attendance_tenants WHERE channel_phone_number_id = $1
        UNION ALL
        SELECT 1 FROM app_attendance_tenants WHERE id = 'pizzaria-demo' AND $1 = 'local-phone-number'
        LIMIT 1
      `,
      [message.providerPhoneNumberId]
    );
    if (channelRes.rowCount === 0) {
      return "UNKNOWN_CHANNEL";
    }

    const insertRes = await this.pool.query(
      `
        INSERT INTO app_inbound_events (
          provider, provider_event_id, provider_phone_number_id, payload_json,
          status, attempts, received_at_ms, next_attempt_at_ms
        ) VALUES ($1, $2, $3, $4::jsonb, 'PENDING', 0, $5, $5)
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        RETURNING id
      `,
      [
        message.provider,
        message.providerEventId,
        message.providerPhoneNumberId,
        JSON.stringify(message),
        timestamp
      ]
    );

    return (insertRes.rowCount ?? 0) === 1 ? "ENQUEUED" : "DUPLICATE";
  }

  private async enqueueLegacyWebhookOnly(message: NormalizedInboundMessage): Promise<EnqueueInboundResult> {
    const result = await this.pool.query<EnqueueQueryResult>(
      `
        WITH channel_match AS (
          SELECT channels.id, channels.tenant_id
          FROM channels
          JOIN tenants ON tenants.id = channels.tenant_id
          WHERE channels.provider = $1
            AND channels.provider_phone_number_id = $2
            AND channels.status = 'ACTIVE'
            AND tenants.status = 'ACTIVE'
          LIMIT 1
        ), inserted AS (
          INSERT INTO webhook_events (
            tenant_id,
            channel_id,
            provider,
            provider_event_id,
            event_type,
            payload,
            status,
            occurred_at
          )
          SELECT
            channel_match.tenant_id,
            channel_match.id,
            $1,
            $3,
            'message.received.v1',
            $4::jsonb,
            'PENDING',
            $5
          FROM channel_match
          ON CONFLICT (provider, provider_event_id) DO NOTHING
          RETURNING id
        )
        SELECT
          (SELECT COUNT(*)::int FROM channel_match) AS channel_count,
          (SELECT COUNT(*)::int FROM inserted) AS inserted_count
      `,
      [
        message.provider,
        message.providerPhoneNumberId,
        message.providerEventId,
        JSON.stringify(message),
        message.occurredAt
      ]
    );

    const row = result.rows[0];
    if (!row || row.channel_count === 0) {
      return "UNKNOWN_CHANNEL";
    }

    return row.inserted_count === 1 ? "ENQUEUED" : "DUPLICATE";
  }

  async takePending(): Promise<NormalizedInboundMessage | undefined> {
    if (!this.database) return undefined;
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE app_inbound_events
          SET status = CASE WHEN attempts >= $1 THEN 'FAILED' ELSE 'PENDING' END,
              lease_expires_at_ms = NULL,
              next_attempt_at_ms = LEAST(next_attempt_at_ms, $2::bigint)
          WHERE status = 'PROCESSING' AND lease_expires_at_ms <= $2::bigint
        `,
        [MAX_INBOUND_ATTEMPTS, now]
      );
      await client.query(
        `
          UPDATE app_inbound_events
          SET status = 'FAILED'
          WHERE status = 'PENDING' AND attempts >= $1
        `,
        [MAX_INBOUND_ATTEMPTS]
      );

      const candidate = await client.query<PendingEventRow>(
        `
          SELECT id, payload_json
          FROM app_inbound_events
          WHERE status = 'PENDING' AND next_attempt_at_ms <= $1::bigint AND attempts < $2
          ORDER BY received_at_ms, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [now, MAX_INBOUND_ATTEMPTS]
      );
      const row = candidate.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }

      const claimed = await client.query(
        `
          UPDATE app_inbound_events
          SET status = 'PROCESSING',
              attempts = attempts + 1,
              lease_expires_at_ms = $1::bigint
          WHERE id = $2 AND status = 'PENDING'
        `,
        [now + INBOUND_LEASE_MS, row.id]
      );
      await client.query("COMMIT");
      if ((claimed.rowCount ?? 0) !== 1) return undefined;
      return deserialize(row.payload_json);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async requeue(message: NormalizedInboundMessage): Promise<void> {
    if (!this.database) return;
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ id: string; attempts: number }>(
        `
          SELECT id, attempts
          FROM app_inbound_events
          WHERE provider = $1 AND provider_event_id = $2 AND status = 'PROCESSING'
          FOR UPDATE
        `,
        [message.provider, message.providerEventId]
      );
      const row = found.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return;
      }
      const exhausted = Number(row.attempts) >= MAX_INBOUND_ATTEMPTS;
      const status = exhausted ? "FAILED" : "PENDING";
      const nextAttemptAt = exhausted ? now : now + retryDelay(Number(row.attempts));
      await client.query(
        `
          UPDATE app_inbound_events
          SET status = $1,
              next_attempt_at_ms = $2::bigint,
              lease_expires_at_ms = NULL,
              last_error = CASE WHEN $1 = 'FAILED' THEN 'max_attempts_exceeded' ELSE NULL END
          WHERE id = $3 AND status = 'PROCESSING'
        `,
        [status, nextAttemptAt, row.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async acknowledge(message: NormalizedInboundMessage): Promise<void> {
    if (!this.database) return;
    // Attendance repository writes are serialized through the database queue.
    // Commit the conversation snapshot before marking its durable inbound event processed.
    await this.database.flush();
    await this.pool.query(
      `
        UPDATE app_inbound_events
        SET status = 'PROCESSED',
            processed_at_ms = $1::bigint,
            lease_expires_at_ms = NULL,
            last_error = NULL
        WHERE provider = $2 AND provider_event_id = $3 AND status = 'PROCESSING'
      `,
      [Date.now(), message.provider, message.providerEventId]
    );
  }

  async isReady(): Promise<boolean> {
    if (this.database) return this.database.isReady();
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.database) {
      await this.database.close();
      return;
    }
    await this.pool.end();
  }
}
