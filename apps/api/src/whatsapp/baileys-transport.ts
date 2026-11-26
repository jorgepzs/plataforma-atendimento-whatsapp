import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Clock } from "./clock.js";
import { reconnectDelay } from "./clock.js";
import { classifyDisconnect, disconnectDetails } from "./disconnect.js";
import { acquireDirectoryLock, type SessionLock } from "./session-lock.js";
import { chatAddressFromInbound, destinationJid, phoneFromJid, safeTenantId } from "./text.js";
import type { WhatsAppConnectionStatus, WhatsAppInboundMessage, WhatsAppStatus, WhatsAppTransport, TransportSendResult } from "./types.js";

export interface BaileysLikeSocket {
  user?: { id?: string };
  ev: { on(event: string, listener: (payload: any) => void): void };
  sendMessage(jid: string, content: Record<string, unknown>): Promise<{ key?: { id?: string } } | undefined>;
  sendPresenceUpdate(presence: "composing" | "paused", jid: string): Promise<void>;
  readMessages(keys: Array<{ remoteJid: string; id: string; fromMe?: boolean }>): Promise<void>;
  logout(): Promise<void>;
  end(error?: Error): void;
}

export interface BaileysSocketFactory {
  create(sessionDir: string): Promise<BaileysLikeSocket>;
}

interface Runtime {
  status: WhatsAppConnectionStatus;
  halted: boolean;
  haltReason: string | null;
  lastError: string | null;
  phoneNumber: string | null;
  qr: string | null;
  lock: SessionLock | undefined;
  socket: BaileysLikeSocket | undefined;
  generation: number;
  attempt: number;
  stopped: boolean;
  reconnectPending: boolean;
  updatedAt: string;
}

export interface BaileysTransportOptions {
  sessionDir: string;
  factory: BaileysSocketFactory;
  clock: Clock;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  onInbound: (message: WhatsAppInboundMessage) => void;
  onStatus: (status: WhatsAppStatus) => void;
  onMessageAck?: (event: { tenantId: string; providerMessageId: string; ack: "delivered" | "read" | "failed"; detail?: string }) => void;
  toDataUrl?: (qr: string) => Promise<string>;
  isAlive?: (pid: number) => boolean;
}

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "send_failed";
  return message.replace(/\s+/g, " ").slice(0, 300) || "send_failed";
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function messageText(content: Record<string, any> | undefined): string | undefined {
  if (!content) return undefined;
  if (typeof content.conversation === "string") return content.conversation;
  if (typeof content.extendedTextMessage?.text === "string") return content.extendedTextMessage.text;
  for (const key of ["imageMessage", "videoMessage", "documentMessage"] as const) {
    const caption = content[key]?.caption;
    if (typeof caption === "string") return caption;
  }
  if (typeof content.buttonsResponseMessage?.selectedDisplayText === "string") return content.buttonsResponseMessage.selectedDisplayText;
  if (typeof content.listResponseMessage?.title === "string") return content.listResponseMessage.title;
  return undefined;
}

function messageType(content: Record<string, any> | undefined): WhatsAppInboundMessage["type"] {
  if (!content) return "unknown";
  if (typeof content.conversation === "string" || content.extendedTextMessage) return "text";
  if (content.imageMessage) return "image";
  if (content.audioMessage) return "audio";
  if (content.videoMessage) return "video";
  if (content.documentMessage) return "document";
  return "unknown";
}

export class BaileysWhatsAppTransport implements WhatsAppTransport {
  readonly id = "unofficial_qr" as const;
  private readonly sessions = new Map<string, Runtime>();
  private idle: Promise<void> = Promise.resolve();

  constructor(private readonly options: BaileysTransportOptions) {}

  whenIdle(): Promise<void> {
    return this.idle;
  }

  async connect(tenantId: string): Promise<void> {
    const runtime = this.ensure(tenantId);
    if (runtime.halted && (runtime.haltReason === "banned" || runtime.haltReason === "restricted")) return;
    runtime.stopped = false;
    if (runtime.socket && (runtime.status === "connected" || runtime.status === "qr_pending" || runtime.status === "connecting")) return;
    await this.open(tenantId);
  }

  async disconnect(tenantId: string): Promise<void> {
    const runtime = this.sessions.get(tenantId);
    if (!runtime) return;
    runtime.stopped = true;
    runtime.generation += 1;
    runtime.qr = null;
    const socket = runtime.socket;
    runtime.socket = undefined;
    try {
      socket?.end(new Error("disconnect"));
    } catch {
      // Encerrar o socket é best-effort.
    }
    this.release(runtime);
    this.publish(tenantId, { status: "disconnected", halted: false, haltReason: null, lastError: null, phoneNumber: runtime.phoneNumber });
  }

  async logout(tenantId: string): Promise<void> {
    const runtime = this.ensure(tenantId);
    runtime.stopped = true;
    runtime.generation += 1;
    runtime.qr = null;
    const socket = runtime.socket;
    runtime.socket = undefined;
    try {
      await socket?.logout();
    } catch {
      try {
        socket?.end(new Error("logout"));
      } catch {
        // A sessão local ainda será apagada.
      }
    }
    this.release(runtime);
    const directory = this.directoryFor(tenantId);
    if (directory) rmSync(directory, { recursive: true, force: true });
    runtime.phoneNumber = null;
    this.publish(tenantId, { status: "logged_out", halted: false, haltReason: null, lastError: null, phoneNumber: null });
  }

  status(tenantId: string): WhatsAppStatus {
    const runtime = this.sessions.get(tenantId);
    return this.toStatus(tenantId, runtime);
  }

  async qrDataUrl(tenantId: string): Promise<string | null> {
    return this.sessions.get(tenantId)?.qr ?? null;
  }

  async sendText(tenantId: string, input: { to: string; text: string }): Promise<TransportSendResult> {
    const socket = this.readySocket(tenantId);
    if (!socket) return { ok: false, reason: "not_connected" };
    const jid = destinationJid(input.to);
    if (!jid) return { ok: false, reason: "rejected", detail: "invalid_jid" };
    try {
      const result = await socket.sendMessage(jid, { text: input.text });
      const providerMessageId = result?.key?.id;
      if (!providerMessageId) return { ok: false, reason: "rejected", detail: "missing_message_id" };
      return { ok: true, providerMessageId };
    } catch (error) {
      return { ok: false, reason: "network", detail: errorDetail(error) };
    }
  }

  async sendMedia(tenantId: string, input: {
    to: string;
    kind: "image" | "audio" | "video" | "document";
    data: Uint8Array;
    mimeType: string;
    fileName?: string;
    caption?: string;
  }): Promise<TransportSendResult> {
    const socket = this.readySocket(tenantId);
    if (!socket) return { ok: false, reason: "not_connected" };
    const buffer = Buffer.from(input.data);
    const content: Record<string, unknown> = input.kind === "image"
      ? { image: buffer, mimetype: input.mimeType, ...(input.caption ? { caption: input.caption } : {}) }
      : input.kind === "audio"
        ? { audio: buffer, mimetype: input.mimeType }
        : input.kind === "video"
          ? { video: buffer, mimetype: input.mimeType, ...(input.caption ? { caption: input.caption } : {}) }
          : { document: buffer, mimetype: input.mimeType, ...(input.fileName ? { fileName: input.fileName } : {}), ...(input.caption ? { caption: input.caption } : {}) };
    const jid = destinationJid(input.to);
    if (!jid) return { ok: false, reason: "rejected", detail: "invalid_jid" };
    try {
      const result = await socket.sendMessage(jid, content);
      const providerMessageId = result?.key?.id;
      if (!providerMessageId) return { ok: false, reason: "rejected", detail: "missing_message_id" };
      return { ok: true, providerMessageId };
    } catch (error) {
      return { ok: false, reason: "network", detail: errorDetail(error) };
    }
  }

  async sendPresence(tenantId: string, to: string, presence: "composing" | "paused"): Promise<void> {
    const socket = this.readySocket(tenantId);
    if (!socket) return;
    const jid = destinationJid(to);
    if (!jid) return;
    await socket.sendPresenceUpdate(presence, jid);
  }

  async markRead(tenantId: string, input: { to: string; messageId: string }): Promise<void> {
    const socket = this.readySocket(tenantId);
    if (!socket) return;
    const jid = destinationJid(input.to);
    if (!jid) return;
    await socket.readMessages([{ remoteJid: jid, id: input.messageId, fromMe: false }]);
  }

  async restorePairedSessions(): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      entries = readdirSync(this.options.sessionDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeTenantId(entry.name)) continue;
      if (!existsSync(path.join(this.options.sessionDir, entry.name, "creds.json"))) continue;
      await this.connect(entry.name);
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((tenantId) => this.disconnect(tenantId)));
  }

  private async open(tenantId: string): Promise<void> {
    const directory = this.directoryFor(tenantId);
    const runtime = this.ensure(tenantId);
    if (!directory || runtime.stopped) return;
    runtime.generation += 1;
    const generation = runtime.generation;
    if (!runtime.lock) {
      try {
        runtime.lock = acquireDirectoryLock(directory, this.options.isAlive ? { isAlive: this.options.isAlive } : {});
      } catch {
        this.publish(tenantId, { status: "failed", halted: true, haltReason: "session_locked", lastError: "session_locked", phoneNumber: runtime.phoneNumber });
        return;
      }
    }
    this.publish(tenantId, {
      status: runtime.attempt > 0 ? "reconnecting" : "connecting",
      halted: false,
      haltReason: null,
      lastError: null,
      phoneNumber: runtime.phoneNumber
    });
    let socket: BaileysLikeSocket;
    try {
      socket = await this.options.factory.create(directory);
    } catch (error) {
      this.publish(tenantId, {
        status: "failed",
        halted: false,
        haltReason: null,
        lastError: "socket_start_failed",
        phoneNumber: runtime.phoneNumber
      });
      this.scheduleReconnect(tenantId, generation);
      return;
    }
    if (generation !== runtime.generation || runtime.stopped) {
      try {
        socket.end(new Error("superseded"));
      } catch {
        // A geração nova já assumiu a sessão.
      }
      return;
    }
    runtime.socket = socket;
    socket.ev.on("connection.update", (update) => {
      const task = this.onConnection(tenantId, generation, socket, update);
      this.idle = this.idle.then(() => task.then(() => undefined, () => undefined));
    });
    socket.ev.on("messages.upsert", (update) => {
      this.onMessages(tenantId, update);
    });
    socket.ev.on("messages.update", (updates) => {
      this.onMessageUpdates(tenantId, updates);
    });
  }

  private async onConnection(tenantId: string, generation: number, socket: BaileysLikeSocket, update: any): Promise<void> {
    const runtime = this.ensure(tenantId);
    if (runtime.generation !== generation) return;
    if (typeof update?.qr === "string") {
      runtime.qr = await this.encodeQr(update.qr);
      this.publish(tenantId, { status: "qr_pending", halted: false, haltReason: null, lastError: null, phoneNumber: runtime.phoneNumber });
    }
    if (update?.connection === "open") {
      runtime.attempt = 0;
      runtime.qr = null;
      const phone = socket.user?.id ? phoneFromJid(socket.user.id) ?? null : null;
      if (phone) runtime.phoneNumber = phone;
      this.publish(tenantId, { status: "connected", halted: false, haltReason: null, lastError: null, phoneNumber: runtime.phoneNumber });
    }
    if (update?.connection === "close") {
      const details = disconnectDetails(update?.lastDisconnect?.error);
      const decision = classifyDisconnect(details.statusCode, details.text);
      if (runtime.socket === socket) runtime.socket = undefined;
      try {
        socket.end(new Error("closed"));
      } catch {
        // O socket já encerrou.
      }
      if (decision.action === "halt") {
        runtime.qr = null;
        runtime.generation += 1;
        this.publish(tenantId, {
          status: decision.status,
          halted: true,
          haltReason: decision.reason,
          lastError: decision.reason,
          phoneNumber: runtime.phoneNumber
        });
        this.release(runtime);
        return;
      }
      this.scheduleReconnect(tenantId, generation);
    }
  }

  private scheduleReconnect(tenantId: string, generation: number): void {
    const runtime = this.ensure(tenantId);
    if (runtime.stopped || runtime.generation !== generation || runtime.reconnectPending) return;
    const delay = reconnectDelay(runtime.attempt, this.options.reconnectBaseMs, this.options.reconnectMaxMs, () => this.options.clock.random());
    runtime.attempt += 1;
    runtime.reconnectPending = true;
    this.publish(tenantId, { status: "reconnecting", halted: false, haltReason: null, lastError: null, phoneNumber: runtime.phoneNumber });
    const task = this.options.clock.sleep(delay).then(async () => {
      runtime.reconnectPending = false;
      if (runtime.stopped || runtime.generation !== generation) return;
      await this.open(tenantId);
    });
    this.idle = this.idle.then(() => task.then(() => undefined, () => undefined));
  }

  private onMessages(tenantId: string, update: any): void {
    if (update?.type !== "notify" || !Array.isArray(update.messages)) return;
    for (const message of update.messages) {
      const remote = message?.key?.remoteJid;
      if (typeof remote !== "string" || message?.key?.fromMe) continue;
      const alt = firstString(message?.key?.senderPn, message?.key?.remoteJidAlt, message?.key?.participantPn);
      const address = chatAddressFromInbound(remote, alt);
      const id = message?.key?.id;
      if (!address || typeof id !== "string" || !id) continue;
      const content = message?.message as Record<string, any> | undefined;
      const text = messageText(content);
      const timestampValue = Number(message?.messageTimestamp);
      const timestamp = Number.isFinite(timestampValue) && timestampValue > 0
        ? new Date(timestampValue > 10_000_000_000 ? timestampValue : timestampValue * 1000)
        : this.options.clock.now();
      const profileName = typeof message?.pushName === "string" ? message.pushName : undefined;
      this.options.onInbound({
        tenantId,
        provider: "unofficial_qr",
        providerMessageId: id,
        from: address.contactId,
        replyJid: address.replyJid,
        phone: address.phone,
        ...(address.aliases.length > 0 ? { aliases: address.aliases } : {}),
        ...(profileName ? { profileName } : {}),
        timestamp,
        type: messageType(content),
        ...(text ? { text } : {})
      });
    }
  }

  private onMessageUpdates(tenantId: string, updates: unknown): void {
    if (!Array.isArray(updates)) return;
    for (const item of updates) {
      const key = item?.key;
      const id = key?.id;
      if (key?.fromMe !== true || typeof id !== "string" || !id) continue;
      const status = Number(item?.update?.status);
      const detail = Array.isArray(item?.update?.messageStubParameters)
        ? item.update.messageStubParameters.filter((part: unknown) => typeof part === "string").join(" ")
        : undefined;
      const ack = status === 3 ? "delivered" : status === 4 || status === 5 ? "read" : status === 0 ? "failed" : undefined;
      if (!ack) continue;
      this.options.onMessageAck?.({ tenantId, providerMessageId: id, ack, ...(detail ? { detail } : {}) });
    }
  }

  private async encodeQr(qr: string): Promise<string> {
    if (this.options.toDataUrl) return this.options.toDataUrl(qr);
    const qrcode = await import("qrcode");
    return qrcode.toDataURL(qr, { margin: 1, width: 280 });
  }

  private readySocket(tenantId: string): BaileysLikeSocket | undefined {
    const runtime = this.sessions.get(tenantId);
    if (!runtime || runtime.halted || runtime.status !== "connected" || !runtime.socket) return undefined;
    return runtime.socket;
  }

  private directoryFor(tenantId: string): string | undefined {
    const safe = safeTenantId(tenantId);
    if (!safe) return undefined;
    return path.join(this.options.sessionDir, safe);
  }

  private ensure(tenantId: string): Runtime {
    const existing = this.sessions.get(tenantId);
    if (existing) return existing;
    const created: Runtime = {
      status: "disconnected",
      halted: false,
      haltReason: null,
      lastError: null,
      phoneNumber: null,
      qr: null,
      lock: undefined,
      socket: undefined,
      generation: 0,
      attempt: 0,
      stopped: false,
      reconnectPending: false,
      updatedAt: this.options.clock.now().toISOString()
    };
    this.sessions.set(tenantId, created);
    return created;
  }

  private release(runtime: Runtime): void {
    try {
      runtime.lock?.release();
    } catch {
      // O lock pode já ter sido removido no logout.
    }
    runtime.lock = undefined;
  }

  private publish(tenantId: string, patch: {
    status: WhatsAppConnectionStatus;
    halted: boolean;
    haltReason: string | null;
    lastError: string | null;
    phoneNumber: string | null;
  }): void {
    const runtime = this.ensure(tenantId);
    runtime.status = patch.status;
    runtime.halted = patch.halted;
    runtime.haltReason = patch.haltReason;
    runtime.lastError = patch.lastError;
    runtime.phoneNumber = patch.phoneNumber;
    runtime.updatedAt = this.options.clock.now().toISOString();
    this.options.onStatus(this.toStatus(tenantId, runtime));
  }

  private toStatus(tenantId: string, runtime: Runtime | undefined): WhatsAppStatus {
    return {
      tenantId,
      provider: "unofficial_qr",
      status: runtime?.status ?? "disconnected",
      halted: runtime?.halted ?? false,
      haltReason: runtime?.haltReason ?? null,
      phoneNumber: runtime?.phoneNumber ?? null,
      pairedAt: null,
      lastError: runtime?.lastError ?? null,
      qrAvailable: Boolean(runtime?.qr),
      updatedAt: runtime?.updatedAt ?? this.options.clock.now().toISOString()
    };
  }
}
