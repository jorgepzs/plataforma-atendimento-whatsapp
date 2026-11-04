import { Pool } from "pg";
import type { NormalizedInboundMessage } from "../../meta/inbound-message.js";
import type { EnqueueInboundResult, InboundEventStore } from "../../ports/inbound-event-store.js";

interface EnqueueQueryResult {
  channel_count: number;
  inserted_count: number;
}

export class PostgresInboundEventStore implements InboundEventStore {
  readonly kind = "postgres" as const;

  constructor(private readonly pool: Pool) {}

  async enqueue(message: NormalizedInboundMessage): Promise<EnqueueInboundResult> {
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

  async isReady(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

