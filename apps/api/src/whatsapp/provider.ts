import type { Clock } from "./clock.js";
import { typingDuration } from "./clock.js";
import {
  bucketCount,
  dayMs,
  evaluateOutbound,
  hourMs,
  inWarmup,
  minuteMs,
  windowStart,
  type PolicyBucketSnapshot
} from "./policy.js";
import { SendQueue } from "./queue.js";
import type { AntiBanSettings } from "./settings.js";
import { mergeAntiBan } from "./settings.js";
import {
  blankTenant,
  ChannelStateStore,
  contactKey,
  emptyBucket,
  type BucketRecord,
  type ChannelDocument,
  type ContactRecord,
  type TenantChannelRecord
} from "./state-store.js";
import { contactIdFrom, destinationJid, isOptOutMessage, splitOutboundText, textFingerprint } from "./text.js";
import type {
  WhatsAppInboundMessage,
  WhatsAppOutboundMedia,
  WhatsAppOutboundText,
  WhatsAppProvider,
  WhatsAppProviderId,
  WhatsAppSendOutcome,
  WhatsAppStatus,
  WhatsAppTransport
} from "./types.js";

export interface PolicyProviderOptions {
  transports: Record<WhatsAppProviderId, WhatsAppTransport>;
  store: ChannelStateStore;
  settings: AntiBanSettings;
  defaultProvider: WhatsAppProviderId;
  clock?: Clock;
  onAlert?: (alert: { tenantId: string; status: string; reason: string; at: string }) => void;
}

function counts(record: BucketRecord | undefined, nowMs: number): PolicyBucketSnapshot {
  const bucket = record ?? emptyBucket();
  return {
    minute: bucketCount(bucket.minuteStart, bucket.minuteCount, nowMs, minuteMs),
    hour: bucketCount(bucket.hourStart, bucket.hourCount, nowMs, hourMs),
    day: bucketCount(bucket.dayStart, bucket.dayCount, nowMs, dayMs)
  };
}

function bump(record: BucketRecord, nowMs: number): void {
  const minute = windowStart(nowMs, minuteMs);
  const hour = windowStart(nowMs, hourMs);
  const day = windowStart(nowMs, dayMs);
  if (record.minuteStart !== minute) {
    record.minuteStart = minute;
    record.minuteCount = 0;
  }
  if (record.hourStart !== hour) {
    record.hourStart = hour;
    record.hourCount = 0;
  }
  if (record.dayStart !== day) {
    record.dayStart = day;
    record.dayCount = 0;
  }
  record.minuteCount += 1;
  record.hourCount += 1;
  record.dayCount += 1;
}

function ensureTenant(draft: ChannelDocument, tenantId: string, provider: WhatsAppProviderId, now: string): TenantChannelRecord {
  const existing = draft.tenants[tenantId];
  if (existing) return existing;
  const created = blankTenant(provider, now);
  draft.tenants[tenantId] = created;
  return created;
}

export class PolicyWhatsAppProvider implements WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  private readonly queue = new SendQueue();
  private readonly inboundHandlers = new Set<(message: WhatsAppInboundMessage) => void>();
  private readonly statusHandlers = new Set<(status: WhatsAppStatus) => void>();
  private readonly clock: Clock;

  constructor(private readonly options: PolicyProviderOptions) {
    this.id = options.defaultProvider;
    this.clock = options.clock ?? {
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
      random: () => Math.random()
    };
  }

  async connect(tenantId: string): Promise<void> {
    const tenant = this.readTenant(tenantId);
    if (tenant.halted && (tenant.haltReason === "banned" || tenant.haltReason === "restricted")) return;
    this.options.store.update((draft) => {
      const record = ensureTenant(draft, tenantId, this.id, this.clock.now().toISOString());
      if (record.haltReason === "banned" || record.haltReason === "restricted") return;
      record.halted = false;
      record.haltReason = null;
      record.status = "connecting";
      record.updatedAt = this.clock.now().toISOString();
    });
    await this.transport(tenantId).connect(tenantId);
  }

  async disconnect(tenantId: string): Promise<void> {
    await this.transport(tenantId).disconnect(tenantId);
  }

  async logout(tenantId: string): Promise<void> {
    await this.transport(tenantId).logout(tenantId);
    this.options.store.update((draft) => {
      const record = ensureTenant(draft, tenantId, this.id, this.clock.now().toISOString());
      if (record.phoneNumber) delete draft.phones[record.phoneNumber];
      record.phoneNumber = null;
      record.pairedAt = null;
      record.halted = false;
      record.haltReason = null;
      record.status = "logged_out";
      record.lastError = null;
      record.updatedAt = this.clock.now().toISOString();
    });
  }

  status(tenantId: string): WhatsAppStatus {
    const stored = this.readTenant(tenantId);
    const live = this.transport(tenantId).status(tenantId);
    const halted = stored.halted || live.halted;
    return {
      tenantId,
      provider: stored.provider,
      status: stored.halted ? stored.status : live.status,
      halted,
      haltReason: stored.haltReason ?? live.haltReason,
      phoneNumber: stored.phoneNumber ?? live.phoneNumber,
      pairedAt: stored.pairedAt ?? live.pairedAt,
      lastError: live.lastError ?? stored.lastError,
      qrAvailable: live.qrAvailable,
      updatedAt: live.updatedAt || stored.updatedAt
    };
  }

  qrDataUrl(tenantId: string): Promise<string | null> {
    return this.transport(tenantId).qrDataUrl(tenantId);
  }

  /** Leitura do contador do dia e do aquecimento. Não altera a política de envio. */
  usageSnapshot(tenantId: string): {
    sentToday: number;
    dailyCap: number;
    effectiveDailyCap: number;
    warmupDay: number;
    warmupDays: number;
    inWarmup: boolean;
  } {
    const now = this.clock.now();
    const settings = this.settingsFor(tenantId);
    const pairedAt = this.status(tenantId).pairedAt;
    const sentToday = counts(this.options.store.snapshot().buckets[`tenant:${tenantId}`], now.getTime()).day;
    const warming = inWarmup(pairedAt, now, settings.warmupDays);
    const pairedMs = pairedAt ? Date.parse(pairedAt) : Number.NaN;
    const elapsedDay = Number.isFinite(pairedMs) ? Math.floor((now.getTime() - pairedMs) / dayMs) + 1 : 1;
    const warmupDay = Math.min(settings.warmupDays, Math.max(1, elapsedDay));
    return {
      sentToday,
      dailyCap: settings.dailyCap,
      effectiveDailyCap: warming ? Math.min(settings.dailyCap, settings.warmupDailyCap) : settings.dailyCap,
      warmupDay: warming ? warmupDay : settings.warmupDays,
      warmupDays: settings.warmupDays,
      inWarmup: warming
    };
  }

  contactConsent(tenantId: string, phone: string): { known: boolean; optedOut: boolean; optedIn: boolean } {
    const normalized = this.canonicalContact(tenantId, phone);
    if (!normalized) return { known: false, optedOut: false, optedIn: false };
    const contact = this.options.store.snapshot().contacts[contactKey(tenantId, normalized)];
    if (!contact) return { known: false, optedOut: false, optedIn: false };
    return { known: true, optedOut: contact.optedOut, optedIn: contact.optedIn };
  }

  async sendText(tenantId: string, message: WhatsAppOutboundText): Promise<WhatsAppSendOutcome> {
    const contactId = this.canonicalContact(tenantId, message.to);
    const destination = this.outboundDestination(tenantId, contactId, message.replyJid);
    if (!contactId || !destination) return { ok: false, reason: "invalid_recipient" };
    const decision = this.authorize(tenantId, { ...message, to: contactId });
    if (!decision.allow) return { ok: false, reason: decision.reason };
    return this.queue.enqueue(tenantId, async () => {
      const transport = this.transport(tenantId);
      const live = transport.status(tenantId);
      if (this.readTenant(tenantId).halted || live.halted) return { ok: false, reason: "halted" };
      if (live.status !== "connected") return { ok: false, reason: "not_connected" };
      await this.clock.sleep(decision.delayMs);
      if (this.readTenant(tenantId).halted) return { ok: false, reason: "halted" };
      if (decision.markRead && message.inboundMessageId) {
        await transport.markRead(tenantId, { to: destination, messageId: message.inboundMessageId }).catch(() => undefined);
      }
      let providerMessageId = "sent";
      for (const chunk of decision.chunks) {
        if (decision.sendTyping) {
          await transport.sendPresence(tenantId, destination, "composing").catch(() => undefined);
          await this.clock.sleep(typingDuration(chunk, this.settingsFor(tenantId)));
          await transport.sendPresence(tenantId, destination, "paused").catch(() => undefined);
        }
        const result = await transport.sendText(tenantId, { to: destination, text: chunk });
        if (!result.ok) return { ok: false, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
        providerMessageId = result.providerMessageId;
      }
      return { ok: true, providerMessageId, chunks: decision.chunks.length };
    });
  }

  async sendMedia(tenantId: string, message: WhatsAppOutboundMedia): Promise<WhatsAppSendOutcome> {
    const contactId = this.canonicalContact(tenantId, message.to);
    const destination = this.outboundDestination(tenantId, contactId, undefined);
    if (!contactId || !destination) return { ok: false, reason: "invalid_recipient" };
    const caption = message.caption?.trim() ?? "";
    if (caption && splitOutboundText(caption, this.settingsFor(tenantId).maxMessageChars).length > 1) {
      return { ok: false, reason: "message_too_long" };
    }
    const decision = this.authorize(tenantId, {
      to: contactId,
      text: caption,
      kind: message.kindOfSend,
      role: message.role,
      emptyAllowed: caption.length === 0
    });
    if (!decision.allow) return { ok: false, reason: decision.reason };
    if (caption && decision.chunks.length > 1) return { ok: false, reason: "message_too_long" };
    return this.queue.enqueue(tenantId, async () => {
      const transport = this.transport(tenantId);
      if (this.readTenant(tenantId).halted || transport.status(tenantId).status !== "connected") {
        return { ok: false, reason: this.readTenant(tenantId).halted ? "halted" : "not_connected" };
      }
      await this.clock.sleep(decision.delayMs);
      if (decision.sendTyping) {
        await transport.sendPresence(tenantId, destination, "composing").catch(() => undefined);
        await this.clock.sleep(typingDuration(caption || "midia", this.settingsFor(tenantId)));
        await transport.sendPresence(tenantId, destination, "paused").catch(() => undefined);
      }
      const result = await transport.sendMedia(tenantId, {
        to: destination,
        kind: message.kind,
        data: message.data,
        mimeType: message.mimeType,
        ...(message.fileName ? { fileName: message.fileName } : {}),
        ...(caption ? { caption } : {})
      });
      if (!result.ok) return { ok: false, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
      return { ok: true, providerMessageId: result.providerMessageId, chunks: 1 };
    });
  }

  async sendPresence(tenantId: string, to: string, presence: "composing" | "paused"): Promise<void> {
    const destination = this.outboundDestination(tenantId, this.canonicalContact(tenantId, to), undefined);
    if (!destination) return;
    await this.transport(tenantId).sendPresence(tenantId, destination, presence);
  }

  async markRead(tenantId: string, input: { to: string; messageId: string }): Promise<void> {
    const destination = this.outboundDestination(tenantId, this.canonicalContact(tenantId, input.to), undefined);
    if (!destination) return;
    await this.transport(tenantId).markRead(tenantId, { to: destination, messageId: input.messageId });
  }

  rememberChat(tenantId: string, input: { contactId: string; replyJid: string; aliases?: string[] }): void {
    const replyJid = destinationJid(input.replyJid);
    const contactId = contactIdFrom(input.contactId);
    if (!replyJid || !contactId) return;
    this.options.store.update((draft) => {
      for (const alias of input.aliases ?? []) {
        if (!alias || alias === contactId) continue;
        const fromKey = contactKey(tenantId, alias);
        const toKey = contactKey(tenantId, contactId);
        const previous = draft.contacts[fromKey];
        if (previous && !draft.contacts[toKey]) draft.contacts[toKey] = previous;
        delete draft.contacts[fromKey];
        const fromBucket = `contact:${tenantId}:${alias}`;
        const toBucket = `contact:${tenantId}:${contactId}`;
        const bucket = draft.buckets[fromBucket];
        if (bucket && !draft.buckets[toBucket]) draft.buckets[toBucket] = bucket;
        delete draft.buckets[fromBucket];
        draft.identities[fromKey] = contactId;
      }
      draft.replyJids[contactKey(tenantId, contactId)] = replyJid;
    });
  }

  replyJidFor(tenantId: string, contactId: string): string | undefined {
    const canonical = this.canonicalContact(tenantId, contactId);
    if (!canonical) return undefined;
    return this.options.store.snapshot().replyJids[contactKey(tenantId, canonical)];
  }

  onInbound(handler: (message: WhatsAppInboundMessage) => void): void {
    this.inboundHandlers.add(handler);
  }

  onStatus(handler: (status: WhatsAppStatus) => void): void {
    this.statusHandlers.add(handler);
  }

  async stop(): Promise<void> {
    await Promise.all(Object.values(this.options.transports).map((transport) => transport.stop()));
  }

  emitInbound(message: WhatsAppInboundMessage): void {
    for (const handler of this.inboundHandlers) {
      try {
        handler(message);
      } catch {
        // Um assinante não impede os demais de ver a mensagem.
      }
    }
  }

  observeStatus(status: WhatsAppStatus): void {
    let alert: { tenantId: string; status: string; reason: string; at: string } | undefined;
    let duplicate = false;
    this.options.store.update((draft) => {
      const record = ensureTenant(draft, status.tenantId, status.provider, status.updatedAt);
      const previousReason = record.haltReason;
      const sticky = record.halted && (record.haltReason === "banned" || record.haltReason === "restricted" || record.haltReason === "duplicate_number");
      if (sticky && !status.halted) return;
      record.status = status.status;
      record.halted = status.halted;
      record.haltReason = status.haltReason;
      record.lastError = status.lastError;
      record.updatedAt = status.updatedAt;
      record.provider = status.provider;
      if (status.phoneNumber) {
        const owner = draft.phones[status.phoneNumber];
        if (owner && owner !== status.tenantId) {
          duplicate = true;
          record.halted = true;
          record.haltReason = "duplicate_number";
          record.status = "failed";
          record.lastError = "duplicate_number";
        } else {
          draft.phones[status.phoneNumber] = status.tenantId;
          record.phoneNumber = status.phoneNumber;
        }
      }
      if (status.status === "connected" && !record.pairedAt && !record.halted) {
        record.pairedAt = status.updatedAt;
      }
      if (record.halted && record.haltReason && record.haltReason !== previousReason) {
        alert = { tenantId: status.tenantId, status: record.status, reason: record.haltReason, at: status.updatedAt };
      }
    });
    if (duplicate) void this.transport(status.tenantId).disconnect(status.tenantId);
    if (alert) this.options.onAlert?.(alert);
    const merged = this.status(status.tenantId);
    for (const handler of this.statusHandlers) {
      try {
        handler(merged);
      } catch {
        // Observadores externos não interrompem o canal.
      }
    }
  }

  recordInbound(tenantId: string, phone: string, at: string, text: string): { optedOut: boolean; freshOptOut: boolean } {
    const normalizedPhone = contactIdFrom(phone);
    if (!normalizedPhone) return { optedOut: false, freshOptOut: false };
    let result = { optedOut: false, freshOptOut: false };
    this.options.store.update((draft) => {
      const settings = this.settingsForDraft(draft, tenantId);
      const canonical = draft.identities[contactKey(tenantId, normalizedPhone)] ?? normalizedPhone;
      const key = contactKey(tenantId, canonical);
      const existing = draft.contacts[key];
      const contact: ContactRecord = existing ?? {
        firstInboundAt: at,
        lastInboundAt: at,
        optedOut: false,
        optedIn: false,
        optOutNoticePending: false,
        outboundCount: 0,
        lastOutboundText: null,
        lastOutboundAt: null
      };
      contact.lastInboundAt = at;
      const optOut = isOptOutMessage(text, settings.optOutKeywords);
      if (optOut && !contact.optedOut) {
        contact.optedOut = true;
        contact.optedIn = false;
        contact.optOutNoticePending = true;
        result = { optedOut: true, freshOptOut: true };
      } else {
        result = { optedOut: contact.optedOut, freshOptOut: false };
      }
      draft.contacts[key] = contact;
    });
    return result;
  }

  setOptIn(tenantId: string, phone: string, optedIn: boolean): boolean {
    const normalized = this.canonicalContact(tenantId, phone);
    if (!normalized) return false;
    let changed = false;
    this.options.store.update((draft) => {
      const contact = draft.contacts[contactKey(tenantId, normalized)];
      if (!contact?.firstInboundAt) return;
      contact.optedIn = optedIn;
      if (optedIn) contact.optedOut = false;
      changed = true;
    });
    return changed;
  }

  clearOptOut(tenantId: string, phone: string): boolean {
    const normalized = this.canonicalContact(tenantId, phone);
    if (!normalized) return false;
    let changed = false;
    this.options.store.update((draft) => {
      const contact = draft.contacts[contactKey(tenantId, normalized)];
      if (!contact) return;
      contact.optedOut = false;
      contact.optOutNoticePending = false;
      changed = true;
    });
    return changed;
  }

  settingsFor(tenantId: string): AntiBanSettings {
    return this.settingsForDraft(this.options.store.snapshot(), tenantId);
  }

  private settingsForDraft(draft: ChannelDocument, tenantId: string): AntiBanSettings {
    return mergeAntiBan(this.options.settings, draft.tenants[tenantId]?.policy);
  }

  private canonicalContact(tenantId: string, value: string): string | undefined {
    const id = contactIdFrom(value);
    if (!id) return undefined;
    return this.options.store.snapshot().identities[contactKey(tenantId, id)] ?? id;
  }

  private outboundDestination(tenantId: string, contactId: string | undefined, replyJid: string | undefined): string | undefined {
    if (!contactId) return undefined;
    const provider = this.readTenant(tenantId).provider ?? this.id;
    if (provider !== "unofficial_qr") return contactId.startsWith("lid:") ? undefined : contactId;
    return destinationJid(replyJid ?? "") ?? this.replyJidFor(tenantId, contactId) ?? destinationJid(contactId);
  }

  private readTenant(tenantId: string): TenantChannelRecord {
    const snapshot = this.options.store.snapshot();
    return snapshot.tenants[tenantId] ?? blankTenant(this.id, this.clock.now().toISOString());
  }

  private transport(tenantId: string): WhatsAppTransport {
    const provider = this.readTenant(tenantId).provider ?? this.id;
    return this.options.transports[provider];
  }

  private authorize(tenantId: string, message: WhatsAppOutboundText & { emptyAllowed?: boolean }): ReturnType<typeof evaluateOutbound> {
    let decision: ReturnType<typeof evaluateOutbound> = { allow: false, reason: "not_connected" };
    this.options.store.update((draft) => {
      const now = this.clock.now();
      const record = ensureTenant(draft, tenantId, this.id, now.toISOString());
      const settings = this.settingsForDraft(draft, tenantId);
      const phone = message.to;
      const contact = draft.contacts[contactKey(tenantId, phone)];
      const live = this.options.transports[record.provider].status(tenantId);
      const recent = new Set(draft.identical.filter((item) =>
        item.tenantId === tenantId && item.hash === textFingerprint(message.text) && item.to !== phone && now.getTime() - item.at < settings.massIdenticalWindowMs
      ).map((item) => item.to));
      decision = evaluateOutbound({
        now,
        kind: message.kind,
        role: message.role,
        text: message.text,
        ...(message.optOutNotice ? { optOutNotice: true } : {}),
        ...(message.emptyAllowed ? { emptyAllowed: true } : {}),
        pairedAt: record.pairedAt,
        halted: record.halted || live.halted,
        haltReason: record.haltReason ?? live.haltReason,
        connected: live.status === "connected",
        contact: contact ? { ...contact } : undefined,
        global: counts(draft.buckets[`tenant:${tenantId}`], now.getTime()),
        contactBucket: counts(draft.buckets[`contact:${tenantId}:${phone}`], now.getTime()),
        recentIdenticalRecipients: recent.size,
        random: () => this.clock.random(),
        settings
      });
      if (!decision.allow) return;
      const globalKey = `tenant:${tenantId}`;
      const contactBucketKey = `contact:${tenantId}:${phone}`;
      const globalBucket = draft.buckets[globalKey] ?? emptyBucket();
      const contactBucket = draft.buckets[contactBucketKey] ?? emptyBucket();
      bump(globalBucket, now.getTime());
      bump(contactBucket, now.getTime());
      draft.buckets[globalKey] = globalBucket;
      draft.buckets[contactBucketKey] = contactBucket;
      const stored = draft.contacts[contactKey(tenantId, phone)];
      if (stored) {
        stored.outboundCount += 1;
        stored.lastOutboundText = decision.fingerprint;
        stored.lastOutboundAt = now.toISOString();
        if (decision.consumeNotice) stored.optOutNoticePending = false;
      }
      draft.identical.push({ tenantId, to: phone, hash: decision.fingerprint, at: now.getTime() });
    });
    return decision;
  }
}
