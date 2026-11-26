import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAttendanceService } from "../src/attendance/service.js";
import type { Clock } from "../src/whatsapp/clock.js";
import { jitterDelay, typingDuration } from "../src/whatsapp/clock.js";
import { createWhatsAppChannel } from "../src/whatsapp/channel.js";
import { classifyDisconnect } from "../src/whatsapp/disconnect.js";
import { BaileysWhatsAppTransport, type BaileysLikeSocket } from "../src/whatsapp/baileys-transport.js";
import { MetaCloudTransport } from "../src/whatsapp/meta-transport.js";
import { evaluateOutbound, inWarmup, isQuietHours } from "../src/whatsapp/policy.js";
import { PolicyWhatsAppProvider } from "../src/whatsapp/provider.js";
import { acquireDirectoryLock } from "../src/whatsapp/session-lock.js";
import { defaultAntiBanSettings, disabledWhatsAppConfig } from "../src/whatsapp/settings.js";
import { ChannelStateStore } from "../src/whatsapp/state-store.js";
import { isOptOutMessage, splitOutboundText } from "../src/whatsapp/text.js";
import type { WhatsAppStatus, WhatsAppTransport, TransportSendResult } from "../src/whatsapp/types.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { loadConfig } from "../src/config.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "wa-test-"));
  directories.push(directory);
  return directory;
}

function clockAt(iso: string, random = 0): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(iso),
    sleep: async (ms: number) => { sleeps.push(ms); },
    random: () => random
  };
}

function baseInput(overrides: Partial<Parameters<typeof evaluateOutbound>[0]> = {}) {
  const settings = defaultAntiBanSettings();
  return {
    now: new Date("2026-06-15T15:00:00.000Z"),
    kind: "reply" as const,
    role: "BOT" as const,
    text: "Olá, posso ajudar?",
    pairedAt: "2026-01-01T00:00:00.000Z",
    halted: false,
    haltReason: null,
    connected: true,
    contact: {
      firstInboundAt: "2026-06-15T14:00:00.000Z",
      optedOut: false,
      optedIn: false,
      optOutNoticePending: false,
      outboundCount: 2,
      lastOutboundText: null,
      lastOutboundAt: null
    },
    global: { minute: 0, hour: 0, day: 0 },
    contactBucket: { minute: 0, hour: 0, day: 0 },
    recentIdenticalRecipients: 0,
    random: () => 0,
    settings,
    ...overrides
  };
}

class FakeTransport implements WhatsAppTransport {
  readonly id;
  sent: Array<{ tenantId: string; to: string; text: string }> = [];
  presence: Array<{ tenantId: string; to: string; presence: string }> = [];
  reads: Array<{ tenantId: string; to: string; messageId: string }> = [];
  current: WhatsAppStatus;

  constructor(id: WhatsAppTransport["id"], status: WhatsAppStatus["status"] = "connected") {
    this.id = id;
    this.current = {
      tenantId: "tenant",
      provider: id,
      status,
      halted: false,
      haltReason: null,
      phoneNumber: "5511999990000",
      pairedAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
      qrAvailable: false,
      updatedAt: "2026-06-15T15:00:00.000Z"
    };
  }

  async connect(): Promise<void> { this.current = { ...this.current, status: "connected", halted: false }; }
  async disconnect(): Promise<void> { this.current = { ...this.current, status: "disconnected" }; }
  async logout(): Promise<void> { this.current = { ...this.current, status: "logged_out", phoneNumber: null }; }
  status(tenantId: string): WhatsAppStatus { return { ...this.current, tenantId }; }
  async qrDataUrl(): Promise<string | null> { return this.current.qrAvailable ? "data:image/png;base64,qr" : null; }
  async sendText(tenantId: string, input: { to: string; text: string }): Promise<TransportSendResult> {
    this.sent.push({ tenantId, ...input });
    return { ok: true, providerMessageId: `id-${this.sent.length}` };
  }
  async sendMedia(): Promise<TransportSendResult> { return { ok: false, reason: "unsupported" }; }
  async sendPresence(tenantId: string, to: string, presence: "composing" | "paused"): Promise<void> {
    this.presence.push({ tenantId, to, presence });
  }
  async markRead(tenantId: string, input: { to: string; messageId: string }): Promise<void> {
    this.reads.push({ tenantId, ...input });
  }
  async restorePairedSessions(): Promise<void> {}
  async stop(): Promise<void> {}
}

function providerWith(transport: FakeTransport, clock: Clock = clockAt("2026-06-15T15:00:00.000Z")) {
  const meta = new FakeTransport("meta_cloud", "disconnected");
  const transports = transport.id === "meta_cloud"
    ? { unofficial_qr: new FakeTransport("unofficial_qr", "disconnected"), meta_cloud: transport }
    : { unofficial_qr: transport, meta_cloud: meta };
  const store = new ChannelStateStore(undefined, () => clock.now());
  const provider = new PolicyWhatsAppProvider({
    transports,
    store,
    settings: defaultAntiBanSettings(),
    defaultProvider: transport.id,
    clock
  });
  return { provider, store, transports };
}

async function drain(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("anti-ban policy", () => {
  it("applies quiet hours only to proactive sends, in America/Sao_Paulo", () => {
    const quiet = new Date("2026-11-26T00:30:00.000Z");
    const open = new Date("2026-11-26T15:00:00.000Z");
    expect(isQuietHours(quiet, 21, 8, "America/Sao_Paulo")).toBe(true);
    expect(isQuietHours(open, 21, 8, "America/Sao_Paulo")).toBe(false);
    expect(isQuietHours(new Date("2026-11-26T10:30:00.000Z"), 21, 8, "America/Sao_Paulo")).toBe(true);
    expect(isQuietHours(new Date("2026-11-26T11:00:00.000Z"), 21, 8, "America/Sao_Paulo")).toBe(false);

    const settings = { ...defaultAntiBanSettings(), proactiveEnabled: true };
    const contact = {
      firstInboundAt: "2026-11-20T12:00:00.000Z",
      optedOut: false,
      optedIn: true,
      optOutNoticePending: false,
      outboundCount: 3,
      lastOutboundText: null,
      lastOutboundAt: null
    };
    expect(evaluateOutbound(baseInput({ now: quiet, kind: "proactive", settings, contact })).allow).toBe(false);
    expect(evaluateOutbound(baseInput({ now: quiet, kind: "proactive", settings, contact }))).toMatchObject({ reason: "quiet_hours" });
    expect(evaluateOutbound(baseInput({ now: quiet, kind: "reply", settings, contact })).allow).toBe(true);
  });

  it("keeps proactive sends disabled until opt-in and a prior inbound exist", () => {
    expect(evaluateOutbound(baseInput({ kind: "proactive" }))).toMatchObject({ reason: "proactive_disabled" });
    const settings = { ...defaultAntiBanSettings(), proactiveEnabled: true };
    expect(evaluateOutbound(baseInput({
      kind: "proactive",
      settings,
      contact: undefined
    }))).toMatchObject({ reason: "no_prior_inbound" });
    expect(evaluateOutbound(baseInput({ kind: "proactive", settings }))).toMatchObject({ reason: "missing_opt_in" });
  });

  it("enforces global and per-contact caps, warm-up and opt-out", () => {
    expect(evaluateOutbound(baseInput({ global: { minute: 4, hour: 0, day: 0 } }))).toMatchObject({ reason: "rate_minute" });
    expect(evaluateOutbound(baseInput({ contactBucket: { minute: 0, hour: 0, day: 15 } }))).toMatchObject({ reason: "contact_rate_day" });
    expect(inWarmup("2026-06-10T15:00:00.000Z", new Date("2026-06-15T15:00:00.000Z"), 7)).toBe(true);
    expect(inWarmup("2026-01-01T00:00:00.000Z", new Date("2026-06-15T15:00:00.000Z"), 7)).toBe(false);
    expect(evaluateOutbound(baseInput({
      pairedAt: "2026-06-14T15:00:00.000Z",
      global: { minute: 0, hour: 0, day: 25 }
    }))).toMatchObject({ reason: "rate_day" });
    expect(evaluateOutbound(baseInput({
      contact: { ...baseInput().contact!, optedOut: true }
    }))).toMatchObject({ reason: "opted_out" });
    expect(isOptOutMessage("PARAR!", ["sair", "parar", "stop"])).toBe(true);
    expect(isOptOutMessage("não quero parar agora", ["parar"])).toBe(false);
  });

  it("blocks link spam, duplicate text and mass identical messages", () => {
    expect(evaluateOutbound(baseInput({ text: "Veja https://a.test e https://b.test" }))).toMatchObject({ reason: "too_many_links" });
    const fingerprint = evaluateOutbound(baseInput()).allow
      ? (evaluateOutbound(baseInput()) as { fingerprint: string }).fingerprint
      : "";
    expect(evaluateOutbound(baseInput({
      contact: {
        ...baseInput().contact!,
        lastOutboundText: fingerprint,
        lastOutboundAt: "2026-06-15T14:30:00.000Z"
      }
    }))).toMatchObject({ reason: "duplicate_text" });
    expect(evaluateOutbound(baseInput({ recentIdenticalRecipients: 8 }))).toMatchObject({ reason: "mass_identical" });
  });

  it("adds a longer first-contact delay, jitter bounds and a typing pause", () => {
    const first = evaluateOutbound(baseInput({
      contact: { ...baseInput().contact!, outboundCount: 0 }
    }));
    const later = evaluateOutbound(baseInput());
    expect(first.allow && later.allow).toBe(true);
    if (first.allow && later.allow) {
      expect(first.delayMs - later.delayMs).toBe(defaultAntiBanSettings().firstMessageExtraDelayMs);
      expect(later.delayMs).toBe(defaultAntiBanSettings().minDelayMs);
    }
    const maxDelay = evaluateOutbound(baseInput({ random: () => 1 }));
    expect(maxDelay.allow && maxDelay.delayMs).toBe(defaultAntiBanSettings().maxDelayMs);
    expect(jitterDelay(3_000, 8_000, () => 0)).toBe(3_000);
    expect(jitterDelay(3_000, 8_000, () => 1)).toBe(8_000);
    expect(typingDuration("abcd", { typingMsPerChar: 35, typingMinMs: 1_500, typingMaxMs: 7_000 })).toBe(1_500);
    expect(splitOutboundText(`${"a".repeat(500)}. ${"b".repeat(500)}`, 800).length).toBeGreaterThan(1);
  });

  it("classifies logout, ban, replacement and transient disconnects", () => {
    expect(classifyDisconnect(401)).toMatchObject({ action: "halt", status: "logged_out" });
    expect(classifyDisconnect(403)).toMatchObject({ action: "halt", status: "banned" });
    expect(classifyDisconnect(406)).toMatchObject({ action: "halt", status: "restricted" });
    expect(classifyDisconnect(440)).toMatchObject({ action: "halt", reason: "session_replaced" });
    expect(classifyDisconnect(428)).toMatchObject({ action: "reconnect", status: "reconnecting" });
    expect(classifyDisconnect(515)).toMatchObject({ action: "reconnect" });
    expect(classifyDisconnect(undefined, "device banned")).toMatchObject({ status: "banned" });
  });
});

describe("provider guard", () => {
  it("marks a reply as read, types, then sends after the delay", async () => {
    const clock = clockAt("2026-06-15T15:00:00.000Z");
    const transport = new FakeTransport("unofficial_qr");
    const { provider } = providerWith(transport, clock);
    provider.recordInbound("pizzaria-demo", "5511999990000", "2026-06-15T14:59:00.000Z", "oi");
    const outcome = await provider.sendText("pizzaria-demo", {
      to: "+55 11 99999-0000",
      text: "Funcionamos das 18h às 23h.",
      kind: "reply",
      role: "BOT",
      inboundMessageId: "inbound-1"
    });
    expect(outcome).toMatchObject({ ok: true, chunks: 1 });
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(defaultAntiBanSettings().minDelayMs);
    expect(transport.reads).toEqual([{ tenantId: "pizzaria-demo", to: "5511999990000", messageId: "inbound-1" }]);
    expect(transport.presence.map((item) => item.presence)).toEqual(["composing", "paused"]);
    expect(transport.sent).toEqual([{ tenantId: "pizzaria-demo", to: "5511999990000", text: "Funcionamos das 18h às 23h." }]);
  });

  it("sends one opt-out confirmation and then blocks the bot", async () => {
    const transport = new FakeTransport("unofficial_qr");
    const { provider } = providerWith(transport);
    provider.recordInbound("pizzaria-demo", "5511999990000", "2026-06-15T14:00:00.000Z", "oi");
    const first = provider.recordInbound("pizzaria-demo", "5511999990000", "2026-06-15T14:05:00.000Z", "PARAR");
    expect(first.freshOptOut).toBe(true);
    const notice = await provider.sendText("pizzaria-demo", {
      to: "5511999990000",
      text: "ignorado",
      kind: "reply",
      role: "SYSTEM",
      optOutNotice: true
    });
    const blocked = await provider.sendText("pizzaria-demo", {
      to: "5511999990000",
      text: "Posso ajudar?",
      kind: "reply",
      role: "BOT"
    });
    expect(notice.ok).toBe(true);
    expect(blocked).toMatchObject({ ok: false, reason: "opted_out" });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.text).toContain("Parei as mensagens automáticas");
  });

  it("stops sending when the session is banned", async () => {
    const transport = new FakeTransport("unofficial_qr");
    const { provider } = providerWith(transport);
    provider.recordInbound("pizzaria-demo", "5511999990000", "2026-06-15T14:00:00.000Z", "oi");
    provider.observeStatus({
      tenantId: "pizzaria-demo",
      provider: "unofficial_qr",
      status: "banned",
      halted: true,
      haltReason: "banned",
      phoneNumber: "5511888880000",
      pairedAt: null,
      lastError: "banned",
      qrAvailable: false,
      updatedAt: "2026-06-15T15:00:00.000Z"
    });
    const outcome = await provider.sendText("pizzaria-demo", {
      to: "5511999990000",
      text: "ainda aqui",
      kind: "reply",
      role: "BOT"
    });
    expect(outcome).toMatchObject({ ok: false, reason: "banned" });
    expect(transport.sent).toHaveLength(0);
    expect(provider.status("pizzaria-demo").halted).toBe(true);
  });

  it("does not cold-message a number that never wrote first", async () => {
    const { provider } = providerWith(new FakeTransport("unofficial_qr"));
    const outcome = await provider.sendText("pizzaria-demo", {
      to: "5511999990000",
      text: "promoção",
      kind: "reply",
      role: "BOT"
    });
    expect(outcome).toMatchObject({ ok: false, reason: "no_prior_inbound" });
  });
});

describe("baileys transport", () => {
  it("normalizes inbound messages, exposes the QR and reconnects only transient failures", async () => {
    const sockets: FakeSocket[] = [];
    const inbound: Array<{ from: string; text?: string; type: string }> = [];
    const statuses: string[] = [];
    const clock = clockAt("2026-06-15T15:00:00.000Z");
    const transport = new BaileysWhatsAppTransport({
      sessionDir: tempDir(),
      factory: { create: async () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } },
      clock,
      reconnectBaseMs: 2_000,
      reconnectMaxMs: 60_000,
      toDataUrl: async (qr) => `data:text,${qr}`,
      onInbound: (message) => inbound.push({ from: message.from, ...(message.text ? { text: message.text } : {}), type: message.type }),
      onStatus: (status) => statuses.push(status.status)
    });
    await transport.connect("pizzaria-demo");
    sockets[0]?.emit("connection.update", { qr: "qr-1" });
    await transport.whenIdle();
    expect(await transport.qrDataUrl("pizzaria-demo")).toBe("data:text,qr-1");
    sockets[0]!.user = { id: "5511977770000:17@s.whatsapp.net" };
    sockets[0]?.emit("connection.update", { connection: "open" });
    await transport.whenIdle();
    sockets[0]?.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: { remoteJid: "5511999990000@s.whatsapp.net", fromMe: false, id: "abc" },
        message: { conversation: "Oi" },
        messageTimestamp: 1_700_000_000,
        pushName: "Ana"
      }, {
        key: { remoteJid: "120363000@g.us", fromMe: false, id: "group" },
        message: { conversation: "grupo" }
      }]
    });
    expect(inbound).toEqual([{ from: "5511999990000", text: "Oi", type: "text" }]);
    expect(transport.status("pizzaria-demo").phoneNumber).toBe("5511977770000");

    sockets[0]?.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
    await transport.whenIdle();
    expect(sockets).toHaveLength(2);
    expect(statuses).toContain("reconnecting");

    sockets[1]?.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await transport.whenIdle();
    expect(sockets).toHaveLength(2);
    expect(transport.status("pizzaria-demo")).toMatchObject({ status: "logged_out", halted: true, haltReason: "logged_out" });
  });

  it("halts when another session replaces this one", async () => {
    const sockets: FakeSocket[] = [];
    const transport = new BaileysWhatsAppTransport({
      sessionDir: tempDir(),
      factory: { create: async () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } },
      clock: clockAt("2026-06-15T15:00:00.000Z"),
      reconnectBaseMs: 2_000,
      reconnectMaxMs: 60_000,
      onInbound: () => undefined,
      onStatus: () => undefined
    });
    await transport.connect("pizzaria-demo");
    sockets[0]?.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 440 }, message: "replaced" } }
    });
    await transport.whenIdle();
    expect(transport.status("pizzaria-demo")).toMatchObject({ status: "session_replaced", halted: true });
    expect(sockets).toHaveLength(1);
  });
});

class FakeSocket implements BaileysLikeSocket {
  user?: { id?: string };
  private readonly listeners = new Map<string, Array<(payload: any) => void>>();
  readonly sent: unknown[] = [];

  ev = { on: (event: string, listener: (payload: any) => void) => {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  } };

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  async sendMessage(): Promise<{ key?: { id?: string } }> { return { key: { id: "out" } }; }
  async sendPresenceUpdate(): Promise<void> {}
  async readMessages(): Promise<void> {}
  async logout(): Promise<void> {}
  end(): void {}
}

describe("meta cloud transport", () => {
  it("sends text through the existing Cloud API adapter and keeps media as a skeleton", async () => {
    const directory = tempDir();
    const store = new ChannelStateStore(path.join(directory, "state.json"));
    store.update((draft) => {
      draft.contacts["tenant-1:5511999990000"] = {
        firstInboundAt: "2026-06-15T14:00:00.000Z",
        lastInboundAt: "2026-06-15T14:00:00.000Z",
        optedOut: false,
        optedIn: false,
        optOutNoticePending: false,
        outboundCount: 0,
        lastOutboundText: null,
        lastOutboundAt: null
      };
      draft.tenants["tenant-1"] = {
        provider: "meta_cloud",
        pairedAt: null,
        phoneNumber: null,
        halted: false,
        haltReason: null,
        status: "disconnected",
        lastError: null,
        updatedAt: "2026-06-15T14:00:00.000Z",
        policy: {},
        metaPhoneNumberId: "123456789012345",
        metaAccessToken: "token-secreto"
      };
    });
    const calls: Array<{ url: string; body: string }> = [];
    const transport = new MetaCloudTransport({
      store,
      graphApiVersion: "v24.0",
      now: () => new Date("2026-06-15T15:00:00.000Z"),
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }), { status: 200 });
      }
    });
    expect(await transport.qrDataUrl("tenant-1")).toBeNull();
    await transport.connect("tenant-1");
    expect(transport.status("tenant-1").status).toBe("connected");
    const sent = await transport.sendText("tenant-1", { to: "5511999990000", text: "Olá" });
    expect(sent).toEqual({ ok: true, providerMessageId: "wamid.TEST" });
    expect(calls[0]?.url).toContain("/123456789012345/messages");
    expect(calls[0]?.body).toContain("Olá");
    expect(await transport.sendMedia()).toMatchObject({ ok: false, reason: "unsupported" });
    expect(JSON.stringify(calls)).not.toContain("token-secreto");
  });
});

describe("session lock", () => {
  it("refuses a second live process and replaces a dead lock", () => {
    const directory = tempDir();
    const first = acquireDirectoryLock(directory, { isAlive: () => true });
    expect(() => acquireDirectoryLock(directory, { isAlive: () => true })).toThrow(/já está aberta/);
    first.release();
    const second = acquireDirectoryLock(directory, { isAlive: () => false });
    second.release();
    const third = acquireDirectoryLock(directory, { isAlive: (pid) => pid === process.pid });
    expect(() => acquireDirectoryLock(directory, { isAlive: (pid) => pid === process.pid })).toThrow(/já está aberta/);
    third.release();
  });
});

describe("attendance bridge", () => {
  it("answers a QR inbound message through the provider and keeps the simulator local", async () => {
    const transport = new FakeTransport("unofficial_qr");
    const store = new MemoryInboundEventStore();
    const bridge: { service?: LocalAttendanceService } = {};
    const channel = createWhatsAppChannel({
      config: { ...disabledWhatsAppConfig(), enabled: true, provider: "unofficial_qr", sessionDir: tempDir(), stateDir: tempDir() },
      graphApiVersion: "v24.0",
      resolveChannelId: () => "demo-pizzaria-phone",
      enqueue: (message) => store.enqueue(message),
      onDelivery: (update) => bridge.service?.markDelivery(update.tenantId, update.messageId, update),
      clock: clockAt("2026-06-15T18:00:00.000Z"),
      transports: { unofficial_qr: transport, meta_cloud: new FakeTransport("meta_cloud", "disconnected") }
    });
    const service = new LocalAttendanceService(store, {
      onCustomerMessage: (event) => channel.handleCustomerMessage(event),
      onOutboundMessage: (event) => channel.handleOutbound(event)
    });
    bridge.service = service;
    await store.enqueue({
      provider: "META_WHATSAPP",
      source: "WHATSAPP_QR",
      providerEventId: "qr-1",
      providerPhoneNumberId: "demo-pizzaria-phone",
      consumerPhoneNumber: "5511999990000",
      consumerProfileName: "Ana",
      occurredAt: new Date("2026-06-15T17:59:00.000Z"),
      type: "text",
      text: "oi",
      rawMessage: { ingress: "whatsapp_provider" }
    });
    await service.processPending();
    await drain();
    expect(transport.sent.map((item) => item.text).join(" ")).toContain("Pizzaria Demo");
    const detail = service.getConversation("pizzaria-demo", service.listConversations("pizzaria-demo")[0]!.id);
    expect(detail.messages.some((message) => message.role === "BOT" && message.deliveryStatus === "ACCEPTED")).toBe(true);

    transport.sent.length = 0;
    await service.simulateMessage("pizzaria-demo", { customerName: "Leo", customerPhone: "5511888880000", text: "oi" });
    await service.processPending();
    await drain();
    expect(transport.sent).toHaveLength(0);
  });
});

describe("whatsapp config", () => {
  it("stays off by default and allows a production sqlite channel without the local demo", () => {
    expect(loadConfig({ NODE_ENV: "development" }).whatsapp.enabled).toBe(false);
    const config = loadConfig({
      NODE_ENV: "production",
      API_HOST: "0.0.0.0",
      META_VERIFY_TOKEN: "production-token",
      META_APP_SECRET: "production-secret",
      WHATSAPP_CHANNEL_ENABLED: "true",
      WHATSAPP_PROVIDER: "unofficial_qr",
      WHATSAPP_SESSION_DIR: "/data/whatsapp/sessions",
      LOCAL_SQLITE_PATH: "/data/whatsapp/attendance.sqlite",
      WHATSAPP_DAILY_CAP: "80"
    });
    expect(config.whatsapp.enabled).toBe(true);
    expect(config.whatsapp.antiBan.dailyCap).toBe(80);
    expect(config.databaseUrl).toBeUndefined();
    expect(() => loadConfig({
      NODE_ENV: "production",
      META_VERIFY_TOKEN: "production-token",
      META_APP_SECRET: "production-secret",
      WHATSAPP_CHANNEL_ENABLED: "true",
      WHATSAPP_SESSION_DIR: "/data/whatsapp/sessions",
      LOCAL_SQLITE_PATH: "/data/whatsapp/attendance.sqlite",
      DATABASE_URL: "postgresql://sou:secret@postgres:5432/sou"
    })).toThrow(/não combina com DATABASE_URL/);
  });
});
