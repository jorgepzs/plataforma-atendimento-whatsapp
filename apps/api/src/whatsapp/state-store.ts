import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AntiBanOverride } from "./settings.js";
import type { WhatsAppConnectionStatus, WhatsAppProviderId } from "./types.js";

export interface ContactRecord {
  firstInboundAt: string;
  lastInboundAt: string;
  optedOut: boolean;
  optedIn: boolean;
  optOutNoticePending: boolean;
  outboundCount: number;
  lastOutboundText: string | null;
  lastOutboundAt: string | null;
}

export interface TenantChannelRecord {
  provider: WhatsAppProviderId;
  pairedAt: string | null;
  phoneNumber: string | null;
  halted: boolean;
  haltReason: string | null;
  status: WhatsAppConnectionStatus;
  lastError: string | null;
  updatedAt: string;
  policy: AntiBanOverride;
  metaPhoneNumberId: string | null;
  metaAccessToken: string | null;
}

export interface BucketRecord {
  minuteStart: number;
  minuteCount: number;
  hourStart: number;
  hourCount: number;
  dayStart: number;
  dayCount: number;
}

export interface IdenticalSend {
  tenantId: string;
  to: string;
  hash: string;
  at: number;
}

export interface ChannelDocument {
  version: 1;
  tenants: Record<string, TenantChannelRecord>;
  contacts: Record<string, ContactRecord>;
  buckets: Record<string, BucketRecord>;
  identical: IdenticalSend[];
  phones: Record<string, string>;
}

export function emptyChannelDocument(): ChannelDocument {
  return { version: 1, tenants: {}, contacts: {}, buckets: {}, identical: [], phones: {} };
}

export function contactKey(tenantId: string, phone: string): string {
  return `${tenantId}:${phone}`;
}

export function emptyBucket(): BucketRecord {
  return { minuteStart: 0, minuteCount: 0, hourStart: 0, hourCount: 0, dayStart: 0, dayCount: 0 };
}

export function blankTenant(provider: WhatsAppProviderId, updatedAt: string): TenantChannelRecord {
  return {
    provider,
    pairedAt: null,
    phoneNumber: null,
    halted: false,
    haltReason: null,
    status: "disconnected",
    lastError: null,
    updatedAt,
    policy: {},
    metaPhoneNumberId: null,
    metaAccessToken: null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ChannelStateStore {
  private document: ChannelDocument;

  constructor(private readonly filePath: string | undefined, private readonly now: () => Date = () => new Date()) {
    this.document = filePath ? this.readFile() : emptyChannelDocument();
  }

  snapshot(): ChannelDocument {
    return structuredClone(this.document);
  }

  update(mutator: (draft: ChannelDocument) => void): void {
    const draft = structuredClone(this.document);
    mutator(draft);
    const cutoff = this.now().getTime() - 24 * 60 * 60 * 1_000;
    draft.identical = draft.identical.filter((item) => item.at >= cutoff).slice(-2_000);
    this.document = draft;
    this.persist();
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.document), { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  private readFile(): ChannelDocument {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath!, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1) return emptyChannelDocument();
      const document = emptyChannelDocument();
      if (isRecord(parsed.tenants)) document.tenants = parsed.tenants as ChannelDocument["tenants"];
      if (isRecord(parsed.contacts)) document.contacts = parsed.contacts as ChannelDocument["contacts"];
      if (isRecord(parsed.buckets)) document.buckets = parsed.buckets as ChannelDocument["buckets"];
      if (Array.isArray(parsed.identical)) document.identical = parsed.identical as IdenticalSend[];
      if (isRecord(parsed.phones)) document.phones = parsed.phones as ChannelDocument["phones"];
      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyChannelDocument();
      throw error;
    }
  }
}
