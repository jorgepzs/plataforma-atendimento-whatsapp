import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttendanceSnapshot } from "../src/attendance/types.js";
import type { LocalIdentitySnapshot } from "../src/auth/local-sessions.js";
import {
  MAX_INBOUND_ATTEMPTS,
  SqliteLocalDatabase
} from "../src/infra/sqlite/local-database.js";
import { SqliteInboundEventStore } from "../src/infra/sqlite/sqlite-inbound-event-store.js";
import type { NormalizedInboundMessage } from "../src/meta/inbound-message.js";

describe("SQLite local infrastructure", () => {
  let tempDirectory: string;
  let filename: string;
  let database: SqliteLocalDatabase | undefined;

  beforeEach(() => {
    tempDirectory = mkdtempSync(path.join(tmpdir(), "atende-sqlite-test-"));
    filename = path.join(tempDirectory, "nested", "attendance.sqlite");
    database = undefined;
  });

  afterEach(() => {
    try { database?.close(); } catch { /* the test may have simulated a reopen */ }
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("migrates, round-trips attendance and rolls back a broken snapshot", () => {
    database = new SqliteLocalDatabase(filename);
    expect(database.isReady()).toBe(true);
    expect(database.attendanceRepository.load()).toBeUndefined();

    const snapshot = attendanceSnapshot();
    snapshot.messages.push({
      id: "message-2", conversationId: "conversation-1", role: "BOT", text: "Olá",
      createdAt: "2026-10-03T10:01:00.000Z", deliveryStatus: "SIMULATED", authorName: null
    });
    snapshot.outbox.push({
      id: "message-2", tenantId: "tenant-1", conversationId: "conversation-1", messageId: "message-2",
      sourceInboundMessageId: "message-1", source: "META_WEBHOOK", phoneNumberId: "phone-1",
      lastInboundAt: "2026-10-03T10:00:00.000Z", status: "SIMULATED", blockedReason: null,
      attemptCount: 0, providerMessageId: null, resultCode: "outbound_disabled",
      createdAt: "2026-10-03T10:01:00.000Z", attemptedAt: null, completedAt: null
    });
    database.attendanceRepository.save(snapshot);
    expect(database.attendanceRepository.load()).toEqual(snapshot);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });

    const invalidSnapshot: AttendanceSnapshot = {
      ...snapshot,
      messages: [{ ...snapshot.messages[0]!, id: "orphan-message", conversationId: "missing-conversation" }]
    };
    expect(() => database!.attendanceRepository.save(invalidSnapshot)).toThrow();
    expect(database.attendanceRepository.load()).toEqual(snapshot);

    database.close();
    database = new SqliteLocalDatabase(filename);
    expect(database.attendanceRepository.load()).toEqual(snapshot);
  });

  it("upgrades a populated version-3 database without losing attendance data", () => {
    database = new SqliteLocalDatabase(filename);
    const snapshot = attendanceSnapshot();
    database.attendanceRepository.save(snapshot);
    database.close();
    database = undefined;

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP TABLE attendance_outbox;
      CREATE TABLE attendance_messages_v3 (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES attendance_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('CUSTOMER', 'BOT', 'ATTENDANT')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivery_status TEXT NOT NULL CHECK (delivery_status IN ('RECEIVED', 'SIMULATED')),
        author_name TEXT
      );
      INSERT INTO attendance_messages_v3
        (id, ordinal, conversation_id, role, text, created_at, delivery_status, author_name)
        SELECT id, ordinal, conversation_id, role, text, created_at, delivery_status, author_name
        FROM attendance_messages;
      DROP TABLE attendance_messages;
      ALTER TABLE attendance_messages_v3 RENAME TO attendance_messages;
      ALTER TABLE attendance_conversations DROP COLUMN last_inbound_message_id;
      ALTER TABLE attendance_conversations DROP COLUMN last_inbound_source;
      ALTER TABLE attendance_conversations DROP COLUMN last_inbound_phone_number_id;
      ALTER TABLE attendance_conversations DROP COLUMN last_inbound_at;
      DELETE FROM schema_migrations WHERE version = 4;
      PRAGMA user_version = 3;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    legacy.close();

    database = new SqliteLocalDatabase(filename);
    expect(database.attendanceRepository.load()).toEqual(snapshot);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
  });

  it("persists identity hashes and sessions without plaintext credentials", () => {
    database = new SqliteLocalDatabase(filename);
    database.attendanceRepository.save(attendanceSnapshot());
    const snapshot: LocalIdentitySnapshot = {
      users: [{
        id: "local-user", email: "owner@example.test", displayName: "Owner", platformAdmin: true,
        memberships: [{ tenantId: "tenant-1", role: "TENANT_ADMIN" }],
        saltHex: "a".repeat(32), passwordHashHex: "b".repeat(128)
      }],
      sessions: [{
        tokenHash: "c".repeat(64), userId: "local-user", csrfToken: "csrf-value", expiresAtMs: 2_000_000_000_000
      }]
    };
    database.identityRepository.save(snapshot);
    expect(database.identityRepository.load()).toEqual(snapshot);
    expect(database.prepare("SELECT salt_hex, password_hash_hex FROM local_identity_users").get()).toEqual({
      salt_hex: "a".repeat(32), password_hash_hex: "b".repeat(128)
    });
    expect(database.prepare("SELECT token_hash, csrf_token FROM local_identity_sessions").get()).toEqual({
      token_hash: "c".repeat(64), csrf_token: "csrf-value"
    });

    const invalidSnapshot: LocalIdentitySnapshot = {
      users: [{ ...snapshot.users[0]!, id: "replacement-user" }],
      sessions: [{ ...snapshot.sessions[0]!, userId: "missing-user" }]
    };
    expect(() => database!.identityRepository.save(invalidSnapshot)).toThrow();
    expect(database.identityRepository.load()).toEqual(snapshot);

    const orphanMembershipSnapshot: LocalIdentitySnapshot = {
      users: [{
        ...snapshot.users[0]!, id: "orphan-user", email: "orphan@example.test",
        memberships: [{ tenantId: "missing-tenant", role: "TENANT_ADMIN" }]
      }],
      sessions: []
    };
    expect(() => database!.identityRepository.save(orphanMembershipSnapshot)).toThrow();
    expect(database.identityRepository.load()).toEqual(snapshot);
  });

  it("deduplicates inbound events, persists acknowledgements, and recovers a processing lease after reopen", async () => {
    database = new SqliteLocalDatabase(filename);
    database.attendanceRepository.save(attendanceSnapshot());
    let store = new SqliteInboundEventStore(database);
    const event = inboundEvent();

    await expect(store.enqueue({ ...event, providerPhoneNumberId: "unregistered" })).resolves.toBe("UNKNOWN_CHANNEL");
    await expect(store.enqueue(event)).resolves.toBe("ENQUEUED");
    await expect(store.enqueue(event)).resolves.toBe("DUPLICATE");
    expect(store.takePending()).toEqual(event);

    store.acknowledge(event);
    expect(store.takePending()).toBeUndefined();
    await expect(store.enqueue(event)).resolves.toBe("DUPLICATE");

    const restartEvent = { ...event, providerEventId: "restart-event" };
    await expect(store.enqueue(restartEvent)).resolves.toBe("ENQUEUED");
    expect(store.takePending()).toEqual(restartEvent);
    await store.close();

    database = new SqliteLocalDatabase(filename);
    store = new SqliteInboundEventStore(database);
    expect(store.takePending()).toEqual(restartEvent);
    expect(database.prepare("SELECT status, attempts FROM inbound_events WHERE provider_event_id = ?")
      .get("restart-event")).toEqual({ status: "PROCESSING", attempts: 2 });
  });

  it("applies exponential retry backoff and stops after the attempt limit", async () => {
    database = new SqliteLocalDatabase(filename);
    database.attendanceRepository.save(attendanceSnapshot());
    const store = new SqliteInboundEventStore(database);
    const event = inboundEvent();
    await store.enqueue(event);

    for (let attempt = 1; attempt <= MAX_INBOUND_ATTEMPTS; attempt += 1) {
      expect(store.takePending()).toEqual(event);
      store.requeue(event);
      const row = database.prepare(`
        SELECT status, attempts, next_attempt_at_ms FROM inbound_events WHERE provider_event_id = ?
      `).get(event.providerEventId) as { status: string; attempts: number; next_attempt_at_ms: number };
      expect(row.attempts).toBe(attempt);
      if (attempt < MAX_INBOUND_ATTEMPTS) {
        expect(row.status).toBe("PENDING");
        expect(row.next_attempt_at_ms).toBeGreaterThan(Date.now());
        database.prepare("UPDATE inbound_events SET next_attempt_at_ms = 0 WHERE provider_event_id = ?")
          .run(event.providerEventId);
      } else {
        expect(row.status).toBe("FAILED");
        expect(store.takePending()).toBeUndefined();
      }
    }
  });

  it("refuses a second live writer for the same database", () => {
    database = new SqliteLocalDatabase(filename);
    expect(() => new SqliteLocalDatabase(filename)).toThrow(/processo/);
  });

  it("recovers a writer lock only after its recorded process has exited", () => {
    mkdirSync(path.dirname(filename), { recursive: true });
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    expect(child.status).toBe(0);
    const deadPid = Number(child.stdout);
    expect(Number.isSafeInteger(deadPid)).toBe(true);
    writeFileSync(`${filename}.writer.lock`, JSON.stringify({ pid: deadPid, token: "dead-owner" }));

    database = new SqliteLocalDatabase(filename);
    expect(database.isReady()).toBe(true);
  });

  it("preserves an existing unversioned SQLite database instead of overwriting it", () => {
    mkdirSync(path.dirname(filename), { recursive: true });
    const existing = new DatabaseSync(filename);
    existing.exec("CREATE TABLE user_data (value TEXT NOT NULL); INSERT INTO user_data VALUES ('keep-me');");
    existing.close();

    expect(() => new SqliteLocalDatabase(filename)).toThrow(/preservado sem alterações/);
    const verify = new DatabaseSync(filename);
    try {
      expect(verify.prepare("SELECT value FROM user_data").get()).toEqual({ value: "keep-me" });
    } finally {
      verify.close();
    }
  });
});

function attendanceSnapshot(): AttendanceSnapshot {
  return {
    tenants: [{
      tenant: {
        id: "tenant-1", slug: "tenant-1", displayName: "Tenant One", segment: "outro",
        channelPhoneNumberId: "phone-1"
      },
      config: {
        businessName: "Tenant One", segment: "outro", greeting: "Olá", knowledge: [],
        handoffKeywords: ["ajuda"], assistantMode: "approved_faq", version: 1
      }
    }],
    conversations: [{
      id: "conversation-1", tenantId: "tenant-1", customerName: "Customer", customerPhone: "+5511000000000",
      state: "BOT_ACTIVE", assignedUserId: null, createdAt: "2026-10-03T10:00:00.000Z",
      updatedAt: "2026-10-03T10:00:00.000Z", lastMessagePreview: "Oi", waitingSince: null,
      lastInboundMessageId: null, lastInboundSource: null, lastInboundPhoneNumberId: null, lastInboundAt: null
    }],
    messages: [{
      id: "message-1", conversationId: "conversation-1", role: "CUSTOMER", text: "Oi",
      createdAt: "2026-10-03T10:00:00.000Z", deliveryStatus: "RECEIVED", authorName: "Customer"
    }],
    outbox: [],
    processedInboundIds: ["tenant-1:META_WHATSAPP:event-1"]
  };
}

function inboundEvent(): NormalizedInboundMessage {
  return {
    provider: "META_WHATSAPP", source: "META_WEBHOOK", providerEventId: "event-1", providerPhoneNumberId: "phone-1",
    consumerPhoneNumber: "+5511000000000", consumerProfileName: "Customer",
    occurredAt: new Date("2026-10-03T10:00:00.000Z"), type: "text", text: "Oi", rawMessage: { source: "test" }
  };
}
