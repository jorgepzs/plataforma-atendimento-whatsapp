import type { PendingInboundEventStore } from "../../attendance/types.js";
import type { NormalizedInboundMessage } from "../../meta/inbound-message.js";
import type { EnqueueInboundResult, InboundEventStore } from "../../ports/inbound-event-store.js";
import {
  INBOUND_BACKOFF_BASE_MS,
  INBOUND_BACKOFF_MAX_MS,
  INBOUND_LEASE_MS,
  MAX_INBOUND_ATTEMPTS,
  SqliteLocalDatabase
} from "./local-database.js";

interface InboundEventRow {
  id: number;
  payload_json: string;
}

function deserialize(payload: string): NormalizedInboundMessage {
  const event = JSON.parse(payload) as Partial<NormalizedInboundMessage> & {
    provider: "META_WHATSAPP";
    providerEventId: string;
    providerPhoneNumberId: string;
    consumerPhoneNumber: string;
    occurredAt: string;
    type: NormalizedInboundMessage["type"];
    rawMessage: Record<string, unknown>;
  };
  // Older queued events have no trusted source marker. Keep them ineligible for
  // external delivery instead of guessing whether they came from Meta.
  const source = event.source ?? (event.rawMessage?.source === "local-simulator" ? "LOCAL_SIMULATOR" : "LEGACY_UNKNOWN");
  return { ...event, source, occurredAt: new Date(event.occurredAt) } as NormalizedInboundMessage;
}

function retryDelay(attempt: number): number {
  return Math.min(INBOUND_BACKOFF_BASE_MS * (2 ** Math.max(0, attempt - 1)), INBOUND_BACKOFF_MAX_MS);
}

export class SqliteInboundEventStore implements InboundEventStore, PendingInboundEventStore {
  readonly kind = "sqlite" as const;

  constructor(readonly database: SqliteLocalDatabase) {}

  async enqueue(message: NormalizedInboundMessage): Promise<EnqueueInboundResult> {
    const occurredAt = message.occurredAt;
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
      throw new Error("Evento inbound com occurredAt inválido.");
    }
    const timestamp = Date.now();
    return this.database.transaction(() => {
      const channel = this.database.prepare(`
        SELECT 1 AS registered FROM attendance_tenants WHERE channel_phone_number_id = ?
        UNION ALL
        SELECT 1 FROM attendance_tenants WHERE id = 'pizzaria-demo' AND ? = 'local-phone-number'
        LIMIT 1
      `).get(message.providerPhoneNumberId, message.providerPhoneNumberId);
      if (!channel) return "UNKNOWN_CHANNEL";

      const result = this.database.prepare(`
        INSERT INTO inbound_events (
          provider, provider_event_id, provider_phone_number_id, payload_json,
          status, attempts, received_at_ms, next_attempt_at_ms
        ) VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?)
        ON CONFLICT (provider, provider_event_id) DO NOTHING
      `).run(message.provider, message.providerEventId, message.providerPhoneNumberId,
        JSON.stringify(message), timestamp, timestamp);
      return Number(result.changes) === 1 ? "ENQUEUED" : "DUPLICATE";
    });
  }

  takePending(): NormalizedInboundMessage | undefined {
    const now = Date.now();
    return this.database.transaction(() => {
      this.database.prepare(`
        UPDATE inbound_events
        SET status = CASE WHEN attempts >= ? THEN 'FAILED' ELSE 'PENDING' END,
            lease_expires_at_ms = NULL,
            next_attempt_at_ms = MIN(next_attempt_at_ms, ?)
        WHERE status = 'PROCESSING' AND lease_expires_at_ms <= ?
      `).run(MAX_INBOUND_ATTEMPTS, now, now);
      this.database.prepare(`
        UPDATE inbound_events SET status = 'FAILED'
        WHERE status = 'PENDING' AND attempts >= ?
      `).run(MAX_INBOUND_ATTEMPTS);

      const row = this.database.prepare(`
        SELECT id, payload_json FROM inbound_events
        WHERE status = 'PENDING' AND next_attempt_at_ms <= ? AND attempts < ?
        ORDER BY received_at_ms, id LIMIT 1
      `).get(now, MAX_INBOUND_ATTEMPTS) as InboundEventRow | undefined;
      if (!row) return undefined;

      const result = this.database.prepare(`
        UPDATE inbound_events
        SET status = 'PROCESSING', attempts = attempts + 1, lease_expires_at_ms = ?
        WHERE id = ? AND status = 'PENDING'
      `).run(now + INBOUND_LEASE_MS, row.id);
      if (Number(result.changes) !== 1) return undefined;
      return deserialize(row.payload_json);
    });
  }

  requeue(message: NormalizedInboundMessage): void {
    const now = Date.now();
    this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT id, attempts FROM inbound_events
        WHERE provider = ? AND provider_event_id = ? AND status = 'PROCESSING'
      `).get(message.provider, message.providerEventId) as { id: number; attempts: number } | undefined;
      if (!row) return;

      const exhausted = row.attempts >= MAX_INBOUND_ATTEMPTS;
      const status = exhausted ? "FAILED" : "PENDING";
      const nextAttemptAt = exhausted ? now : now + retryDelay(row.attempts);
      this.database.prepare(`
        UPDATE inbound_events
        SET status = ?, next_attempt_at_ms = ?, lease_expires_at_ms = NULL,
            last_error = CASE WHEN ? = 'FAILED' THEN 'max_attempts_exceeded' ELSE NULL END
        WHERE id = ? AND status = 'PROCESSING'
      `).run(status, nextAttemptAt, status, row.id);
    });
  }

  acknowledge(message: NormalizedInboundMessage): void {
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE inbound_events
        SET status = 'PROCESSED', processed_at_ms = ?, lease_expires_at_ms = NULL, last_error = NULL
        WHERE provider = ? AND provider_event_id = ? AND status = 'PROCESSING'
      `).run(Date.now(), message.provider, message.providerEventId);
    });
  }

  async isReady(): Promise<boolean> {
    return this.database.isReady();
  }

  async close(): Promise<void> {
    this.database.close();
  }
}
