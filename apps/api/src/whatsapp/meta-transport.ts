import { CloudApiTextSender } from "../infra/meta/cloud-api-text-sender.js";
import { contactKey, type ChannelStateStore } from "./state-store.js";
import type { WhatsAppStatus, WhatsAppTransport, TransportSendResult } from "./types.js";

export interface MetaTransportOptions {
  store: ChannelStateStore;
  graphApiVersion: string;
  defaultPhoneNumberId?: string;
  defaultAccessToken?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Adaptador da Cloud API oficial. O envio de texto reutiliza CloudApiTextSender.
 * Mídia fica como esqueleto até a migração preencher o upload da Graph API.
 */
export class MetaCloudTransport implements WhatsAppTransport {
  readonly id = "meta_cloud" as const;
  private readonly online = new Set<string>();
  private readonly errors = new Map<string, string>();

  constructor(private readonly options: MetaTransportOptions) {}

  async connect(tenantId: string): Promise<void> {
    if (this.credentials(tenantId)) {
      this.online.add(tenantId);
      this.errors.delete(tenantId);
      return;
    }
    this.online.delete(tenantId);
    this.errors.set(tenantId, "missing_credentials");
  }

  async disconnect(tenantId: string): Promise<void> {
    this.online.delete(tenantId);
  }

  async logout(tenantId: string): Promise<void> {
    this.online.delete(tenantId);
  }

  status(tenantId: string): WhatsAppStatus {
    const configured = Boolean(this.credentials(tenantId));
    const connected = configured && this.online.has(tenantId);
    return {
      tenantId,
      provider: "meta_cloud",
      status: connected ? "connected" : configured ? "disconnected" : "failed",
      halted: false,
      haltReason: null,
      phoneNumber: null,
      pairedAt: null,
      lastError: this.errors.get(tenantId) ?? (configured ? null : "missing_credentials"),
      qrAvailable: false,
      updatedAt: (this.options.now ?? (() => new Date()))().toISOString()
    };
  }

  async qrDataUrl(_tenantId: string): Promise<string | null> {
    return null;
  }

  async sendText(tenantId: string, input: { to: string; text: string }): Promise<TransportSendResult> {
    const credentials = this.credentials(tenantId);
    if (!credentials || !this.online.has(tenantId)) return { ok: false, reason: "not_connected" };
    const contact = this.options.store.snapshot().contacts[contactKey(tenantId, input.to)];
    const lastInboundAt = contact?.lastInboundAt ? new Date(contact.lastInboundAt) : undefined;
    if (!lastInboundAt || !Number.isFinite(lastInboundAt.getTime())) {
      return { ok: false, reason: "rejected", detail: "missing_inbound" };
    }
    const sender = new CloudApiTextSender({
      enabled: true,
      graphApiVersion: this.options.graphApiVersion,
      phoneNumberId: credentials.phoneNumberId,
      accessToken: credentials.accessToken,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.now ? { now: this.options.now } : {})
    });
    const result = await sender.sendText({ recipient: input.to, body: input.text, lastInboundAt });
    if (result.status === "ACCEPTED") return { ok: true, providerMessageId: result.providerMessageId };
    if (result.status === "HTTP_ERROR") {
      return { ok: false, reason: result.category === "provider_unavailable" ? "network" : "rejected", detail: result.category };
    }
    if (result.status === "INDETERMINATE") return { ok: false, reason: "network", detail: result.reason };
    return { ok: false, reason: "rejected", detail: result.reason };
  }

  async sendMedia(): Promise<TransportSendResult> {
    return { ok: false, reason: "unsupported", detail: "meta_media_pending" };
  }

  async sendPresence(): Promise<void> {
    // A Cloud API não expõe presença de "digitando" no mesmo contrato do WhatsApp Web.
  }

  async markRead(): Promise<void> {
    // Recibo de leitura da Cloud API entra na migração, quando o webhook de status estiver ligado.
  }

  async restorePairedSessions(): Promise<void> {
    const snapshot = this.options.store.snapshot();
    for (const [tenantId, tenant] of Object.entries(snapshot.tenants)) {
      if (tenant.provider === "meta_cloud") await this.connect(tenantId);
    }
  }

  async stop(): Promise<void> {
    this.online.clear();
  }

  private credentials(tenantId: string): { phoneNumberId: string; accessToken: string } | undefined {
    const tenant = this.options.store.snapshot().tenants[tenantId];
    const phoneNumberId = tenant?.metaPhoneNumberId || this.options.defaultPhoneNumberId;
    const accessToken = tenant?.metaAccessToken || this.options.defaultAccessToken;
    if (!phoneNumberId || !accessToken) return undefined;
    return { phoneNumberId, accessToken };
  }
}
