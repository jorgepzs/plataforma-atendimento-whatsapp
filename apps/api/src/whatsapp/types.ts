export type WhatsAppProviderId = "unofficial_qr" | "meta_cloud";

export type WhatsAppConnectionStatus =
  | "disconnected"
  | "qr_pending"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out"
  | "banned"
  | "restricted"
  | "session_replaced"
  | "failed";

export type WhatsAppInboundType = "text" | "image" | "audio" | "video" | "document" | "unknown";

/** Mensagem interna única, independente do provedor que a recebeu. */
export interface WhatsAppInboundMessage {
  tenantId: string;
  provider: WhatsAppProviderId;
  providerMessageId: string;
  from: string;
  profileName?: string;
  timestamp: Date;
  type: WhatsAppInboundType;
  text?: string;
  media?: {
    mimeType?: string;
    fileName?: string;
    caption?: string;
  };
}

export interface WhatsAppStatus {
  tenantId: string;
  provider: WhatsAppProviderId;
  status: WhatsAppConnectionStatus;
  halted: boolean;
  haltReason: string | null;
  phoneNumber: string | null;
  pairedAt: string | null;
  lastError: string | null;
  qrAvailable: boolean;
  updatedAt: string;
}

export interface WhatsAppOutboundText {
  to: string;
  text: string;
  kind: "reply" | "proactive";
  role: "BOT" | "ATTENDANT" | "SYSTEM";
  inboundMessageId?: string;
  /** Confirmação única depois de SAIR/PARAR/STOP. */
  optOutNotice?: boolean;
}

export interface WhatsAppOutboundMedia {
  to: string;
  kind: "image" | "audio" | "video" | "document";
  data: Uint8Array;
  mimeType: string;
  fileName?: string;
  caption?: string;
  kindOfSend: "reply" | "proactive";
  role: "BOT" | "ATTENDANT" | "SYSTEM";
}

export type WhatsAppSendOutcome =
  | { ok: true; providerMessageId: string; chunks: number }
  | { ok: false; reason: string };

/**
 * Contrato usado pelo atendimento, pela fila e pelo painel.
 * Implementações concretas (Baileys, Cloud API) ficam atrás dele.
 */
export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  connect(tenantId: string): Promise<void>;
  disconnect(tenantId: string): Promise<void>;
  logout(tenantId: string): Promise<void>;
  status(tenantId: string): WhatsAppStatus;
  qrDataUrl(tenantId: string): Promise<string | null>;
  sendText(tenantId: string, message: WhatsAppOutboundText): Promise<WhatsAppSendOutcome>;
  sendMedia(tenantId: string, message: WhatsAppOutboundMedia): Promise<WhatsAppSendOutcome>;
  sendPresence(tenantId: string, to: string, presence: "composing" | "paused"): Promise<void>;
  markRead(tenantId: string, input: { to: string; messageId: string }): Promise<void>;
  onInbound(handler: (message: WhatsAppInboundMessage) => void): void;
  onStatus(handler: (status: WhatsAppStatus) => void): void;
  stop(): Promise<void>;
}

export type TransportSendResult =
  | { ok: true; providerMessageId: string }
  | {
      ok: false;
      reason: "not_connected" | "rejected" | "network" | "unsupported";
      detail?: string;
    };

/** Transporte bruto, sem política anti-ban. O restante da aplicação não usa este tipo. */
export interface WhatsAppTransport {
  readonly id: WhatsAppProviderId;
  connect(tenantId: string): Promise<void>;
  disconnect(tenantId: string): Promise<void>;
  logout(tenantId: string): Promise<void>;
  status(tenantId: string): WhatsAppStatus;
  qrDataUrl(tenantId: string): Promise<string | null>;
  sendText(tenantId: string, input: { to: string; text: string }): Promise<TransportSendResult>;
  sendMedia(tenantId: string, input: {
    to: string;
    kind: "image" | "audio" | "video" | "document";
    data: Uint8Array;
    mimeType: string;
    fileName?: string;
    caption?: string;
  }): Promise<TransportSendResult>;
  sendPresence(tenantId: string, to: string, presence: "composing" | "paused"): Promise<void>;
  markRead(tenantId: string, input: { to: string; messageId: string }): Promise<void>;
  restorePairedSessions(): Promise<void>;
  stop(): Promise<void>;
}
