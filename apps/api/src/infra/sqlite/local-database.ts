import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AttendanceSnapshot, AttendanceStateRepository } from "../../attendance/types.js";
import type { LocalIdentityRepository, LocalIdentitySnapshot } from "../../auth/local-sessions.js";

const migrations = [
  {
    version: 1,
    name: "attendance_and_local_identity",
    sql: `
      CREATE TABLE attendance_tenants (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        segment TEXT NOT NULL CHECK (segment IN ('pizzaria', 'barbearia', 'outro')),
        channel_phone_number_id TEXT NOT NULL UNIQUE
      );

      CREATE TABLE attendance_tenant_configs (
        tenant_id TEXT PRIMARY KEY REFERENCES attendance_tenants(id) ON DELETE CASCADE,
        config_json TEXT NOT NULL CHECK (json_valid(config_json))
      );

      CREATE TABLE attendance_conversations (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL REFERENCES attendance_tenants(id) ON DELETE CASCADE,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('BOT_ACTIVE', 'WAITING_HUMAN', 'HUMAN_ACTIVE', 'CLOSED')),
        assigned_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_preview TEXT NOT NULL,
        waiting_since TEXT
      );

      CREATE TABLE attendance_messages (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES attendance_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('CUSTOMER', 'BOT', 'ATTENDANT')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivery_status TEXT NOT NULL CHECK (delivery_status IN ('RECEIVED', 'SIMULATED')),
        author_name TEXT
      );

      CREATE TABLE attendance_processed_inbound (
        event_key TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE
      );

      CREATE TABLE local_identity_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        platform_admin INTEGER NOT NULL CHECK (platform_admin IN (0, 1)),
        salt_hex TEXT NOT NULL CHECK (length(salt_hex) = 32 AND salt_hex NOT GLOB '*[^0-9a-f]*'),
        password_hash_hex TEXT NOT NULL CHECK (length(password_hash_hex) = 128 AND password_hash_hex NOT GLOB '*[^0-9a-f]*')
      );

      CREATE TABLE local_identity_memberships (
        user_id TEXT NOT NULL REFERENCES local_identity_users(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('TENANT_ADMIN', 'ATTENDANT')),
        PRIMARY KEY (user_id, ordinal)
      );

      CREATE TABLE local_identity_sessions (
        token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
        user_id TEXT NOT NULL REFERENCES local_identity_users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `
  },
  {
    version: 2,
    name: "durable_inbound_events",
    sql: `
      CREATE TABLE inbound_events (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        provider_phone_number_id TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        received_at_ms INTEGER NOT NULL,
        next_attempt_at_ms INTEGER NOT NULL,
        lease_expires_at_ms INTEGER,
        processed_at_ms INTEGER,
        last_error TEXT,
        UNIQUE (provider, provider_event_id),
        CHECK ((status = 'PROCESSING' AND lease_expires_at_ms IS NOT NULL)
          OR (status <> 'PROCESSING' AND lease_expires_at_ms IS NULL))
      );

      CREATE INDEX inbound_events_pending_idx
        ON inbound_events (status, next_attempt_at_ms, received_at_ms, id);
    `
  },
  {
    version: 3,
    name: "tenant_membership_integrity",
    sql: `
      CREATE TABLE local_identity_memberships_v3 (
        user_id TEXT NOT NULL REFERENCES local_identity_users(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        tenant_id TEXT NOT NULL REFERENCES attendance_tenants(id) DEFERRABLE INITIALLY DEFERRED,
        role TEXT NOT NULL CHECK (role IN ('TENANT_ADMIN', 'ATTENDANT')),
        PRIMARY KEY (user_id, ordinal),
        UNIQUE (user_id, tenant_id)
      );

      INSERT INTO local_identity_memberships_v3 (user_id, ordinal, tenant_id, role)
        SELECT user_id, ordinal, tenant_id, role FROM local_identity_memberships;
      DROP TABLE local_identity_memberships;
      ALTER TABLE local_identity_memberships_v3 RENAME TO local_identity_memberships;

      CREATE UNIQUE INDEX attendance_conversations_one_per_customer_idx
        ON attendance_conversations (tenant_id, customer_phone);
    `
  },
  {
    version: 4,
    name: "durable_outbound_outbox",
    sql: `
      ALTER TABLE attendance_conversations ADD COLUMN last_inbound_message_id TEXT;
      ALTER TABLE attendance_conversations ADD COLUMN last_inbound_source TEXT
        CHECK (last_inbound_source IS NULL OR last_inbound_source IN ('META_WEBHOOK', 'LOCAL_SIMULATOR', 'LEGACY_UNKNOWN'));
      ALTER TABLE attendance_conversations ADD COLUMN last_inbound_phone_number_id TEXT;
      ALTER TABLE attendance_conversations ADD COLUMN last_inbound_at TEXT;

      CREATE TABLE attendance_messages_v4 (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES attendance_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('CUSTOMER', 'BOT', 'ATTENDANT')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivery_status TEXT NOT NULL CHECK (delivery_status IN (
          'RECEIVED', 'SIMULATED', 'PENDING', 'SENDING', 'ACCEPTED', 'BLOCKED', 'HTTP_ERROR', 'INDETERMINATE'
        )),
        author_name TEXT
      );
      INSERT INTO attendance_messages_v4
        (id, ordinal, conversation_id, role, text, created_at, delivery_status, author_name)
        SELECT id, ordinal, conversation_id, role, text, created_at, delivery_status, author_name
        FROM attendance_messages;
      DROP TABLE attendance_messages;
      ALTER TABLE attendance_messages_v4 RENAME TO attendance_messages;

      CREATE TABLE attendance_outbox (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL REFERENCES attendance_tenants(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES attendance_conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES attendance_messages(id) ON DELETE CASCADE,
        source_inbound_message_id TEXT,
        source TEXT CHECK (source IS NULL OR source IN ('META_WEBHOOK', 'LOCAL_SIMULATOR', 'LEGACY_UNKNOWN')),
        phone_number_id TEXT,
        last_inbound_at TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'SIMULATED', 'PENDING', 'SENDING', 'ACCEPTED', 'BLOCKED', 'HTTP_ERROR', 'INDETERMINATE'
        )),
        blocked_reason TEXT,
        attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 1),
        provider_message_id TEXT,
        result_code TEXT,
        created_at TEXT NOT NULL,
        attempted_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX attendance_outbox_dispatch_idx ON attendance_outbox (status, created_at, ordinal);
    `
  }
] as const;

interface LockRecord {
  pid: number;
  token: string;
}

interface WriterLock {
  path: string;
  descriptor: number;
  token: string;
}

function readLockRecord(lockPath: string): { record: LockRecord; text: string } {
  const text = readFileSync(lockPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Lock SQLite inválido em ${lockPath}; não é seguro removê-lo automaticamente.`);
  }

  if (
    !parsed || typeof parsed !== "object" ||
    !Number.isSafeInteger((parsed as Partial<LockRecord>).pid) ||
    (parsed as Partial<LockRecord>).pid! <= 0 ||
    typeof (parsed as Partial<LockRecord>).token !== "string"
  ) {
    throw new Error(`Lock SQLite inválido em ${lockPath}; não é seguro removê-lo automaticamente.`);
  }
  return { record: parsed as LockRecord, text };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but cannot be signalled. Any other result
    // is ambiguous, so fail closed and preserve the lock.
    return true;
  }
}

function acquireWriterLock(filename: string): WriterLock | undefined {
  if (filename === ":memory:") return undefined;
  const lockPath = `${filename}.writer.lock`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        const contents = JSON.stringify({ pid: process.pid, token } satisfies LockRecord);
        writeSync(descriptor, contents, 0, "utf8");
        fsyncSync(descriptor);
        return { path: lockPath, descriptor, token };
      } catch (error) {
        closeSync(descriptor);
        rmSync(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let stale: { record: LockRecord; text: string };
    try {
      stale = readLockRecord(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (processIsAlive(stale.record.pid)) {
      throw new Error(`O banco SQLite já está aberto pelo processo ${stale.record.pid}.`);
    }

    // Rename is atomic on the same volume. Re-read after moving so a concurrent
    // replacement is never mistaken for the dead owner's lock.
    const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      renameSync(lockPath, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    const moved = readLockRecord(quarantinePath);
    if (moved.text !== stale.text || processIsAlive(moved.record.pid)) {
      if (!existsSync(lockPath)) renameSync(quarantinePath, lockPath);
      throw new Error(`O lock SQLite mudou durante a recuperação; nenhum lock ativo foi removido.`);
    }
    rmSync(quarantinePath);
  }

  throw new Error("Não foi possível adquirir o lock exclusivo do banco SQLite.");
}

function releaseWriterLock(lock: WriterLock | undefined): void {
  if (!lock) return;
  try {
    const current = readLockRecord(lock.path);
    if (current.record.token === lock.token) rmSync(lock.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    closeSync(lock.descriptor);
  }
}

class SqliteAttendanceRepository implements AttendanceStateRepository {
  constructor(private readonly database: SqliteLocalDatabase) {}

  load(): AttendanceSnapshot | undefined {
    const tenants = this.database.connection.prepare(`
      SELECT t.id, t.slug, t.display_name, t.segment, t.channel_phone_number_id, c.config_json
      FROM attendance_tenants t
      JOIN attendance_tenant_configs c ON c.tenant_id = t.id
      ORDER BY t.ordinal
    `).all() as Array<Record<string, string | number | null>>;
    if (tenants.length === 0) return undefined;

    const conversations = this.database.connection.prepare(`
      SELECT id, tenant_id, customer_name, customer_phone, state, assigned_user_id,
        created_at, updated_at, last_message_preview, waiting_since,
        last_inbound_message_id, last_inbound_source, last_inbound_phone_number_id, last_inbound_at
      FROM attendance_conversations ORDER BY ordinal
    `).all() as Array<Record<string, string | number | null>>;
    const messages = this.database.connection.prepare(`
      SELECT id, conversation_id, role, text, created_at, delivery_status, author_name
      FROM attendance_messages ORDER BY ordinal
    `).all() as Array<Record<string, string | number | null>>;
    const processedInboundIds = this.database.connection.prepare(`
      SELECT event_key FROM attendance_processed_inbound ORDER BY ordinal
    `).all() as Array<{ event_key: string }>;
    const outbox = this.database.connection.prepare(`
      SELECT id, tenant_id, conversation_id, message_id, source_inbound_message_id, source,
        phone_number_id, last_inbound_at, status, blocked_reason, attempt_count,
        provider_message_id, result_code, created_at, attempted_at, completed_at
      FROM attendance_outbox ORDER BY ordinal
    `).all() as Array<Record<string, string | number | null>>;

    return {
      tenants: tenants.map((row) => ({
        tenant: {
          id: String(row.id), slug: String(row.slug), displayName: String(row.display_name),
          segment: String(row.segment) as AttendanceSnapshot["tenants"][number]["tenant"]["segment"],
          channelPhoneNumberId: String(row.channel_phone_number_id)
        },
        config: JSON.parse(String(row.config_json)) as AttendanceSnapshot["tenants"][number]["config"]
      })),
      conversations: conversations.map((row) => ({
        id: String(row.id), tenantId: String(row.tenant_id), customerName: String(row.customer_name),
        customerPhone: String(row.customer_phone),
        state: String(row.state) as AttendanceSnapshot["conversations"][number]["state"],
        assignedUserId: row.assigned_user_id === null ? null : String(row.assigned_user_id),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        lastMessagePreview: String(row.last_message_preview),
        waitingSince: row.waiting_since === null ? null : String(row.waiting_since),
        lastInboundMessageId: row.last_inbound_message_id === null ? null : String(row.last_inbound_message_id),
        lastInboundSource: row.last_inbound_source === null ? null : String(row.last_inbound_source) as AttendanceSnapshot["conversations"][number]["lastInboundSource"],
        lastInboundPhoneNumberId: row.last_inbound_phone_number_id === null ? null : String(row.last_inbound_phone_number_id),
        lastInboundAt: row.last_inbound_at === null ? null : String(row.last_inbound_at)
      })),
      messages: messages.map((row) => ({
        id: String(row.id), conversationId: String(row.conversation_id),
        role: String(row.role) as AttendanceSnapshot["messages"][number]["role"],
        text: String(row.text), createdAt: String(row.created_at),
        deliveryStatus: String(row.delivery_status) as AttendanceSnapshot["messages"][number]["deliveryStatus"],
        authorName: row.author_name === null ? null : String(row.author_name)
      })),
      outbox: outbox.map((row) => ({
        id: String(row.id), tenantId: String(row.tenant_id), conversationId: String(row.conversation_id),
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
        createdAt: String(row.created_at), attemptedAt: row.attempted_at === null ? null : String(row.attempted_at),
        completedAt: row.completed_at === null ? null : String(row.completed_at)
      })),
      processedInboundIds: processedInboundIds.map((row) => row.event_key)
    };
  }

  save(snapshot: AttendanceSnapshot): void {
    this.database.transaction(() => {
      this.database.connection.exec(`
        DELETE FROM attendance_outbox;
        DELETE FROM attendance_processed_inbound;
        DELETE FROM attendance_conversations;
        DELETE FROM attendance_tenants;
      `);

      const insertTenant = this.database.connection.prepare(`
        INSERT INTO attendance_tenants
          (id, ordinal, slug, display_name, segment, channel_phone_number_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertConfig = this.database.connection.prepare(`
        INSERT INTO attendance_tenant_configs (tenant_id, config_json) VALUES (?, ?)
      `);
      snapshot.tenants.forEach(({ tenant, config }, ordinal) => {
        insertTenant.run(tenant.id, ordinal, tenant.slug, tenant.displayName, tenant.segment, tenant.channelPhoneNumberId);
        insertConfig.run(tenant.id, JSON.stringify(config));
      });

      const insertConversation = this.database.connection.prepare(`
        INSERT INTO attendance_conversations
          (id, ordinal, tenant_id, customer_name, customer_phone, state, assigned_user_id,
           created_at, updated_at, last_message_preview, waiting_since, last_inbound_message_id,
           last_inbound_source, last_inbound_phone_number_id, last_inbound_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      snapshot.conversations.forEach((conversation, ordinal) => insertConversation.run(
        conversation.id, ordinal, conversation.tenantId, conversation.customerName, conversation.customerPhone,
        conversation.state, conversation.assignedUserId, conversation.createdAt, conversation.updatedAt,
        conversation.lastMessagePreview, conversation.waitingSince, conversation.lastInboundMessageId,
        conversation.lastInboundSource, conversation.lastInboundPhoneNumberId, conversation.lastInboundAt
      ));

      const insertMessage = this.database.connection.prepare(`
        INSERT INTO attendance_messages
          (id, ordinal, conversation_id, role, text, created_at, delivery_status, author_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      snapshot.messages.forEach((message, ordinal) => insertMessage.run(
        message.id, ordinal, message.conversationId, message.role, message.text, message.createdAt,
        message.deliveryStatus, message.authorName
      ));

      const insertOutbox = this.database.connection.prepare(`
        INSERT INTO attendance_outbox
          (id, ordinal, tenant_id, conversation_id, message_id, source_inbound_message_id, source,
           phone_number_id, last_inbound_at, status, blocked_reason, attempt_count,
           provider_message_id, result_code, created_at, attempted_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      snapshot.outbox.forEach((entry, ordinal) => insertOutbox.run(
        entry.id, ordinal, entry.tenantId, entry.conversationId, entry.messageId,
        entry.sourceInboundMessageId, entry.source, entry.phoneNumberId, entry.lastInboundAt,
        entry.status, entry.blockedReason, entry.attemptCount, entry.providerMessageId,
        entry.resultCode, entry.createdAt, entry.attemptedAt, entry.completedAt
      ));

      const insertProcessed = this.database.connection.prepare(`
        INSERT INTO attendance_processed_inbound (event_key, ordinal) VALUES (?, ?)
      `);
      snapshot.processedInboundIds.forEach((eventKey, ordinal) => insertProcessed.run(eventKey, ordinal));
    });
  }
}

class SqliteIdentityRepository implements LocalIdentityRepository {
  constructor(private readonly database: SqliteLocalDatabase) {}

  load(): LocalIdentitySnapshot | undefined {
    const userRows = this.database.connection.prepare(`
      SELECT id, email, display_name, platform_admin, salt_hex, password_hash_hex
      FROM local_identity_users ORDER BY rowid
    `).all() as Array<Record<string, string | number>>;
    if (userRows.length === 0) return undefined;

    const membershipsByUser = new Map<string, LocalIdentitySnapshot["users"][number]["memberships"]>();
    const membershipRows = this.database.connection.prepare(`
      SELECT user_id, tenant_id, role FROM local_identity_memberships ORDER BY user_id, ordinal
    `).all() as Array<{ user_id: string; tenant_id: string; role: string }>;
    for (const row of membershipRows) {
      const memberships = membershipsByUser.get(row.user_id) ?? [];
      memberships.push({ tenantId: row.tenant_id, role: row.role as "TENANT_ADMIN" | "ATTENDANT" });
      membershipsByUser.set(row.user_id, memberships);
    }

    const sessions = this.database.connection.prepare(`
      SELECT token_hash, user_id, csrf_token, expires_at_ms FROM local_identity_sessions
      ORDER BY rowid
    `).all() as Array<{ token_hash: string; user_id: string; csrf_token: string; expires_at_ms: number }>;

    return {
      users: userRows.map((row) => ({
        id: String(row.id), email: String(row.email), displayName: String(row.display_name),
        platformAdmin: Number(row.platform_admin) === 1,
        memberships: membershipsByUser.get(String(row.id)) ?? [],
        saltHex: String(row.salt_hex), passwordHashHex: String(row.password_hash_hex)
      })),
      sessions: sessions.map((row) => ({
        tokenHash: row.token_hash, userId: row.user_id, csrfToken: row.csrf_token,
        expiresAtMs: Number(row.expires_at_ms)
      }))
    };
  }

  save(snapshot: LocalIdentitySnapshot): void {
    this.database.transaction(() => {
      this.database.connection.exec(`DELETE FROM local_identity_sessions; DELETE FROM local_identity_users;`);
      const insertUser = this.database.connection.prepare(`
        INSERT INTO local_identity_users (id, email, display_name, platform_admin, salt_hex, password_hash_hex)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertMembership = this.database.connection.prepare(`
        INSERT INTO local_identity_memberships (user_id, ordinal, tenant_id, role) VALUES (?, ?, ?, ?)
      `);
      for (const user of snapshot.users) {
        insertUser.run(user.id, user.email, user.displayName, user.platformAdmin ? 1 : 0,
          user.saltHex.toLowerCase(), user.passwordHashHex.toLowerCase());
        user.memberships.forEach((membership, ordinal) => insertMembership.run(
          user.id, ordinal, membership.tenantId, membership.role
        ));
      }

      const insertSession = this.database.connection.prepare(`
        INSERT INTO local_identity_sessions (token_hash, user_id, csrf_token, expires_at_ms)
        VALUES (?, ?, ?, ?)
      `);
      for (const session of snapshot.sessions) {
        insertSession.run(session.tokenHash.toLowerCase(), session.userId, session.csrfToken, session.expiresAtMs);
      }
    });
  }
}

export class SqliteLocalDatabase {
  readonly filename: string;
  readonly connection: DatabaseSync;
  readonly attendanceRepository: AttendanceStateRepository;
  readonly identityRepository: LocalIdentityRepository;
  private readonly writerLock: WriterLock | undefined;
  private closed = false;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(filename: string) {
    if (!filename.trim()) throw new Error("O caminho do banco SQLite não pode ficar vazio.");
    this.filename = filename === ":memory:" ? filename : path.resolve(filename);
    if (this.filename !== ":memory:") mkdirSync(path.dirname(this.filename), { recursive: true });
    this.writerLock = acquireWriterLock(this.filename);

    let connection: DatabaseSync | undefined;
    try {
      connection = new DatabaseSync(this.filename);
      this.connection = connection;
      connection.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; PRAGMA locking_mode = EXCLUSIVE;`);
      this.applyMigrations();
      this.transaction(() => {
        connection!.prepare(`
          UPDATE inbound_events
          SET status = CASE WHEN attempts >= ? THEN 'FAILED' ELSE 'PENDING' END,
              lease_expires_at_ms = NULL,
              next_attempt_at_ms = MIN(next_attempt_at_ms, ?)
          WHERE status = 'PROCESSING'
        `).run(MAX_INBOUND_ATTEMPTS, Date.now());
      });
      connection.exec("BEGIN EXCLUSIVE; COMMIT;");
      this.attendanceRepository = new SqliteAttendanceRepository(this);
      this.identityRepository = new SqliteIdentityRepository(this);
    } catch (error) {
      try { connection?.close(); } catch { /* preserve initialization error */ }
      releaseWriterLock(this.writerLock);
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    this.assertOpen();
    const outermost = this.transactionDepth === 0;
    const savepoint = `sqlite_local_${++this.savepointSequence}`;
    this.connection.exec(outermost ? "BEGIN IMMEDIATE;" : `SAVEPOINT ${savepoint};`);
    this.transactionDepth += 1;
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("Transações SQLite locais devem ser síncronas.");
      }
      if (outermost) this.connection.exec("COMMIT;");
      else this.connection.exec(`RELEASE SAVEPOINT ${savepoint};`);
      return result;
    } catch (error) {
      try {
        if (outermost) this.connection.exec("ROLLBACK;");
        else this.connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint};`);
      } catch { /* SQLite may already have rolled back */ }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  prepare(sql: string): StatementSync {
    this.assertOpen();
    return this.connection.prepare(sql);
  }

  exec(sql: string): void {
    this.assertOpen();
    this.connection.exec(sql);
  }

  isReady(): boolean {
    if (this.closed) return false;
    try {
      this.connection.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.transaction(() => {
        this.connection.prepare(`
          UPDATE inbound_events
          SET status = CASE WHEN attempts >= ? THEN 'FAILED' ELSE 'PENDING' END,
              lease_expires_at_ms = NULL
          WHERE status = 'PROCESSING'
        `).run(MAX_INBOUND_ATTEMPTS);
      });
    } finally {
      this.connection.close();
      this.closed = true;
      releaseWriterLock(this.writerLock);
    }
  }

  private applyMigrations(): void {
    const versionRow = this.connection.prepare("PRAGMA user_version").get() as { user_version: number };
    let version = Number(versionRow.user_version);
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("Versão SQLite inválida.");
    const latest = migrations[migrations.length - 1]!.version;
    if (version > latest) throw new Error(`O banco SQLite está na versão ${version}, mais nova que esta aplicação (${latest}).`);

    if (version === 0) {
      const tables = this.connection.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;
      if (tables.length > 0) {
        throw new Error("Banco SQLite não versionado contém tabelas existentes; ele foi preservado sem alterações.");
      }
    } else {
      const migrationTable = this.connection.prepare(`
        SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
      `).get();
      if (!migrationTable) throw new Error("O banco SQLite não possui o histórico de migrações esperado; foi preservado.");
      const applied = this.connection.prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number; name: string }>;
      const expected = migrations.filter((migration) => migration.version <= version);
      if (applied.length !== expected.length || applied.some((row, index) =>
        row.version !== expected[index]?.version || row.name !== expected[index]?.name
      )) {
        throw new Error("Histórico de migrações SQLite inconsistente; o banco foi preservado sem alterações.");
      }
    }

    for (const migration of migrations) {
      if (migration.version <= version) continue;
      if (migration.version !== version + 1) throw new Error("Sequência de migrações SQLite inválida.");
      this.connection.exec("BEGIN IMMEDIATE;");
      try {
        if (version === 0) {
          this.connection.exec(`
            CREATE TABLE schema_migrations (
              version INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
          `);
        }
        this.connection.exec(migration.sql);
        this.connection.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
          .run(migration.version, migration.name);
        this.connection.exec(`PRAGMA user_version = ${migration.version};`);
        this.connection.exec("COMMIT;");
        version = migration.version;
      } catch (error) {
        try { this.connection.exec("ROLLBACK;"); } catch { /* preserve migration error */ }
        throw error;
      }
    }

    const applied = this.connection.prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;
    const expected = migrations.filter((migration) => migration.version <= version);
    if (applied.length !== expected.length || applied.some((row, index) =>
      row.version !== expected[index]?.version || row.name !== expected[index]?.name
    )) {
      throw new Error("Histórico de migrações SQLite inconsistente; o banco foi preservado.");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("O banco SQLite local já foi fechado.");
  }
}

export const MAX_INBOUND_ATTEMPTS = 5;
export const INBOUND_LEASE_MS = 30_000;
export const INBOUND_BACKOFF_BASE_MS = 1_000;
export const INBOUND_BACKOFF_MAX_MS = 60_000;
