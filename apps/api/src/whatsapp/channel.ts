import type { CustomerMessageNotice, OutboundMessageNotice } from "../attendance/types.js";
import type { NormalizedInboundMessage } from "../meta/inbound-message.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import { BaileysWhatsAppTransport } from "./baileys-transport.js";
import { createBaileysSocketFactory } from "./baileys-socket.js";
import { MetaCloudTransport } from "./meta-transport.js";
import { PolicyWhatsAppProvider } from "./provider.js";
import type { AntiBanOverride, WhatsAppChannelConfig } from "./settings.js";
import { publicAntiBan } from "./settings.js";
import { blankTenant, ChannelStateStore } from "./state-store.js";
import { maskPhone, optOutConfirmationText, safeTenantId } from "./text.js";
import type { WhatsAppSendObservabilitySnapshot } from "./send-observability.js";
import type { WhatsAppInboundMessage, WhatsAppProviderId, WhatsAppStatus, WhatsAppTransport } from "./types.js";

export interface DeliveryUpdate {
  tenantId: string;
  messageId: string;
  status: "ACCEPTED" | "BLOCKED";
  resultCode: string | null;
  providerMessageId?: string;
}

export interface CreateChannelOptions {
  config: WhatsAppChannelConfig;
  graphApiVersion: string;
  resolveChannelId: (tenantId: string) => string | undefined;
  enqueue: (message: NormalizedInboundMessage) => Promise<unknown>;
  onDelivery?: (update: DeliveryUpdate) => void;
  onMessageAck?: (event: { tenantId: string; providerMessageId: string; ack: "delivered" | "read" | "failed"; detail?: string }) => void;
  log?: (level: "debug" | "info" | "warn", payload: Record<string, unknown>, message: string) => void;
  clock?: Clock;
  transports?: Partial<Record<WhatsAppProviderId, WhatsAppTransport>>;
  fetch?: typeof fetch;
}

export interface WhatsAppUsageView {
  sentToday: number;
  dailyCap: number;
  effectiveDailyCap: number;
  warmupDay: number;
  warmupDays: number;
  inWarmup: boolean;
}

export interface WhatsAppPublicView {
  enabled: true;
  testUnlimitedMode: boolean;
  provider: WhatsAppProviderId;
  status: WhatsAppStatus["status"];
  halted: boolean;
  haltReason: string | null;
  phoneMasked: string | null;
  pairedAt: string | null;
  lastError: string | null;
  qrAvailable: boolean;
  decryptFailuresLastHour: number;
  metaConfigured: boolean;
  proactiveEnabled: boolean;
  antiBan: ReturnType<typeof publicAntiBan>;
  usage: WhatsAppUsageView;
  sendObservability: WhatsAppSendObservabilitySnapshot;
}

function stateFile(config: WhatsAppChannelConfig): string | undefined {
  if (!config.stateDir) return undefined;
  return `${config.stateDir.replace(/\/$/, "")}/channel-state.json`;
}

export class WhatsAppChannel {
  readonly provider: PolicyWhatsAppProvider;
  private readonly store: ChannelStateStore;
  private readonly transports: Record<WhatsAppProviderId, WhatsAppTransport>;
  private readonly clock: Clock;

  constructor(private readonly options: CreateChannelOptions, store: ChannelStateStore, provider: PolicyWhatsAppProvider, transports: Record<WhatsAppProviderId, WhatsAppTransport>) {
    this.store = store;
    this.provider = provider;
    this.transports = transports;
    this.clock = options.clock ?? systemClock;
  }

  async start(): Promise<void> {
    await this.transports.unofficial_qr.restorePairedSessions();
    await this.transports.meta_cloud.restorePairedSessions();
  }

  async stop(): Promise<void> {
    await this.provider.stop();
  }

  view(tenantId: string): WhatsAppPublicView {
    const status = this.provider.status(tenantId);
    const tenant = this.store.snapshot().tenants[tenantId];
    const settings = this.provider.settingsFor(tenantId);
    return {
      enabled: true,
      testUnlimitedMode: this.options.config.testUnlimitedMode,
      provider: status.provider,
      status: status.status,
      halted: status.halted,
      haltReason: status.haltReason,
      phoneMasked: status.phoneNumber ? maskPhone(status.phoneNumber) : null,
      pairedAt: status.pairedAt,
      lastError: status.lastError,
      qrAvailable: status.qrAvailable,
      decryptFailuresLastHour: status.decryptFailuresLastHour ?? 0,
      metaConfigured: Boolean((tenant?.metaPhoneNumberId || this.options.config.metaPhoneNumberId) && (tenant?.metaAccessToken || this.options.config.metaAccessToken)),
      proactiveEnabled: settings.proactiveEnabled,
      antiBan: publicAntiBan(settings),
      usage: this.provider.usageSnapshot(tenantId),
      sendObservability: this.provider.sendObservabilitySnapshot(tenantId)
    };
  }

  updateSettings(tenantId: string, patch: {
    provider?: WhatsAppProviderId;
    policy?: AntiBanOverride;
    metaPhoneNumberId?: string | null;
    metaAccessToken?: string | null;
  }): WhatsAppPublicView {
    const safe = safeTenantId(tenantId);
    if (!safe) throw new Error("Empresa inválida para o canal WhatsApp.");
    let previous: WhatsAppProviderId | undefined;
    this.store.update((draft) => {
      const record = draft.tenants[safe] ?? blankTenant(this.options.config.provider, this.clock.now().toISOString());
      previous = record.provider;
      if (patch.provider) record.provider = patch.provider;
      if (patch.policy) record.policy = { ...record.policy, ...patch.policy };
      if (patch.metaPhoneNumberId !== undefined) record.metaPhoneNumberId = patch.metaPhoneNumberId;
      if (patch.metaAccessToken !== undefined) record.metaAccessToken = patch.metaAccessToken;
      record.updatedAt = this.clock.now().toISOString();
      draft.tenants[safe] = record;
    });
    if (patch.provider && previous && patch.provider !== previous) {
      void this.transports[previous].disconnect(safe);
    }
    return this.view(safe);
  }

  async acceptInbound(message: WhatsAppInboundMessage): Promise<void> {
    const channelId = this.options.resolveChannelId(message.tenantId);
    if (!channelId) {
      this.options.log?.("warn", { tenantId: message.tenantId }, "Mensagem WhatsApp sem canal de atendimento.");
      return;
    }
    if (message.replyJid) {
      this.provider.rememberChat(message.tenantId, {
        contactId: message.from,
        replyJid: message.replyJid,
        ...(message.aliases ? { aliases: message.aliases } : {})
      });
    }
    const event: NormalizedInboundMessage = {
      provider: "META_WHATSAPP",
      source: "WHATSAPP_QR",
      providerEventId: message.providerMessageId,
      providerPhoneNumberId: channelId,
      consumerPhoneNumber: message.phone || message.from,
      ...(message.profileName ? { consumerProfileName: message.profileName } : {}),
      occurredAt: message.timestamp,
      type: message.type === "unknown" ? "unknown" : message.type,
      ...(message.text ? { text: message.text } : {}),
      rawMessage: { ingress: "whatsapp_provider", provider: message.provider }
    };
    await this.options.enqueue(event);
  }

  handleCustomerMessage(event: CustomerMessageNotice): void {
    if (event.source !== "WHATSAPP_QR" && event.source !== "META_WEBHOOK") return;
    const recorded = this.provider.recordInbound(event.tenantId, event.phone, event.at, event.text);
    if (!recorded.freshOptOut) return;
    void this.provider.sendText(event.tenantId, {
      to: event.phone,
      text: optOutConfirmationText,
      kind: "reply",
      role: "SYSTEM",
      optOutNotice: true,
      inboundMessageId: event.messageId
    }).then((outcome) => {
      if (!outcome.ok) {
        this.options.log?.("warn", { tenantId: event.tenantId, reason: outcome.reason }, "Confirmação de opt-out não enviada.");
      }
    }).catch(() => undefined);
  }

  handleOutbound(event: OutboundMessageNotice): void {
    const qr = event.source === "WHATSAPP_QR";
    if (!qr && (event.deliveryStatus === "PENDING" || event.deliveryStatus === "SENDING")) return;
    if (qr && (event.deliveryStatus === "ACCEPTED" || event.deliveryStatus === "SENDING")) return;
    const provider = this.store.snapshot().tenants[event.tenantId]?.provider ?? this.options.config.provider;
    const realIngress = (qr && provider === "unofficial_qr")
      || (event.source === "META_WEBHOOK" && provider === "meta_cloud");
    if (!realIngress) return;
    const replyJid = this.provider.replyJidFor(event.tenantId, event.customerPhone);
    void this.provider.sendText(event.tenantId, {
      to: event.customerPhone,
      text: event.text,
      kind: "reply",
      role: event.role,
      ...(replyJid ? { replyJid } : {}),
      ...(event.inboundMessageId ? { inboundMessageId: event.inboundMessageId } : {})
    }).then((outcome) => {
      if (!outcome.ok) {
        this.options.log?.("warn", {
          tenantId: event.tenantId,
          messageId: event.messageId,
          reason: outcome.reason,
          ...(outcome.detail ? { detail: outcome.detail } : {})
        }, "Falha ao enviar mensagem WhatsApp.");
      }
      const resultCode = outcome.ok ? null : [outcome.reason, outcome.detail].filter(Boolean).join(": ");
      this.options.onDelivery?.({
        tenantId: event.tenantId,
        messageId: event.messageId,
        status: outcome.ok ? "ACCEPTED" : "BLOCKED",
        resultCode,
        ...(outcome.ok ? { providerMessageId: outcome.providerMessageId } : {})
      });
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "send_failed";
      this.options.log?.("warn", { tenantId: event.tenantId, messageId: event.messageId, detail }, "Falha ao enviar mensagem WhatsApp.");
      this.options.onDelivery?.({
        tenantId: event.tenantId,
        messageId: event.messageId,
        status: "BLOCKED",
        resultCode: `network: ${detail}`
      });
    });
  }
}

export function createWhatsAppChannel(options: CreateChannelOptions): WhatsAppChannel {
  const clock = options.clock ?? systemClock;
  const store = new ChannelStateStore(stateFile(options.config), () => clock.now());
  let channel: WhatsAppChannel | undefined;
  const unofficial = options.transports?.unofficial_qr ?? new BaileysWhatsAppTransport({
    sessionDir: options.config.sessionDir ?? ".data/whatsapp/sessions",
    factory: createBaileysSocketFactory(options.log ? {
      log: {
        debug: (payload, message) => options.log?.("debug", payload, message),
        warn: (payload, message) => options.log?.("warn", payload, message)
      }
    } : {}),
    clock,
    reconnectBaseMs: options.config.antiBan.reconnectBaseMs,
    reconnectMaxMs: options.config.antiBan.reconnectMaxMs,
    onInbound: (message) => { void channel?.acceptInbound(message); },
    onStatus: (status) => channel?.provider.observeStatus(status),
    onMessageAck: (event) => options.onMessageAck?.(event)
  });
  const meta = options.transports?.meta_cloud ?? new MetaCloudTransport({
    store,
    graphApiVersion: options.graphApiVersion,
    ...(options.config.metaPhoneNumberId ? { defaultPhoneNumberId: options.config.metaPhoneNumberId } : {}),
    ...(options.config.metaAccessToken ? { defaultAccessToken: options.config.metaAccessToken } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now: () => clock.now()
  });
  const transports: Record<WhatsAppProviderId, WhatsAppTransport> = { unofficial_qr: unofficial, meta_cloud: meta };
  const provider = new PolicyWhatsAppProvider({
    transports,
    store,
    settings: options.config.antiBan,
    defaultProvider: options.config.provider,
    testUnlimitedMode: options.config.testUnlimitedMode,
    clock,
    onAlert: (alert) => {
      const phone = store.snapshot().tenants[alert.tenantId]?.phoneNumber;
      const payload = { ...alert, ...(phone ? { phoneMasked: maskPhone(phone) } : {}) };
      options.log?.("warn", payload, "Sessão WhatsApp interrompida.");
      if (!options.config.alertWebhookUrl) return;
      void fetch(options.config.alertWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "whatsapp.session.halted", ...payload }),
        signal: AbortSignal.timeout(5_000)
      }).catch(() => undefined);
    }
  });
  channel = new WhatsAppChannel(options, store, provider, transports);
  return channel;
}
