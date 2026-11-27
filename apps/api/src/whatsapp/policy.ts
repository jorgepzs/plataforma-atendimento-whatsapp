import type { AntiBanSettings } from "./settings.js";
import { linkCount, normalizeForMatch, optOutConfirmationText, splitOutboundText, textFingerprint } from "./text.js";
import { jitterDelay } from "./clock.js";

export interface PolicyContact {
  firstInboundAt: string | null;
  optedOut: boolean;
  optedIn: boolean;
  optOutNoticePending: boolean;
  outboundCount: number;
  lastOutboundText: string | null;
  lastOutboundAt: string | null;
}

export interface PolicyBucketSnapshot {
  minute: number;
  hour: number;
  day: number;
}

export interface PolicyInput {
  now: Date;
  kind: "reply" | "proactive";
  role: "BOT" | "ATTENDANT" | "SYSTEM";
  text: string;
  optOutNotice?: boolean;
  /** Mídia sem legenda ainda conta como envio, mas não é recusada por texto vazio. */
  emptyAllowed?: boolean;
  pairedAt: string | null;
  halted: boolean;
  haltReason: string | null;
  connected: boolean;
  contact: PolicyContact | undefined;
  global: PolicyBucketSnapshot;
  contactBucket: PolicyBucketSnapshot;
  recentIdenticalRecipients: number;
  random: () => number;
  settings: AntiBanSettings;
  testUnlimitedMode?: boolean;
}

export type PolicyDecision =
  | { allow: false; reason: string }
  | {
      allow: true;
      reason: "ok";
      text: string;
      chunks: string[];
      delayMs: number;
      markRead: boolean;
      sendTyping: boolean;
      fingerprint: string;
      consumeNotice: boolean;
    };

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

export function hourInTimeZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23"
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return Number.isFinite(hour) ? hour : 0;
}

export function isQuietHours(now: Date, startHour: number, endHour: number, timeZone: string): boolean {
  if (startHour === endHour) return false;
  const hour = hourInTimeZone(now, timeZone);
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export function inWarmup(pairedAt: string | null, now: Date, warmupDays: number): boolean {
  if (!pairedAt) return true;
  const pairedMs = Date.parse(pairedAt);
  if (!Number.isFinite(pairedMs)) return true;
  return now.getTime() - pairedMs < warmupDays * dayMs;
}

export function evaluateOutbound(input: PolicyInput): PolicyDecision {
  if (input.halted) return { allow: false, reason: input.haltReason ?? "halted" };
  if (!input.connected) return { allow: false, reason: "not_connected" };

  const contact = input.contact;
  const notice = Boolean(input.optOutNotice && contact?.optOutNoticePending && input.role !== "ATTENDANT");
  if (contact?.optedOut && input.role !== "ATTENDANT" && !notice) {
    return { allow: false, reason: "opted_out" };
  }

  const text = notice ? optOutConfirmationText : input.text.trim();
  if (!text && !input.emptyAllowed) return { allow: false, reason: "empty_text" };

  if (input.kind === "proactive") {
    if (!input.settings.proactiveEnabled) return { allow: false, reason: "proactive_disabled" };
    if (!contact?.firstInboundAt) return { allow: false, reason: "no_prior_inbound" };
    if (!contact.optedIn) return { allow: false, reason: "missing_opt_in" };
    if (contact.optedOut) return { allow: false, reason: "opted_out" };
    if (!input.testUnlimitedMode && isQuietHours(input.now, input.settings.quietHoursStart, input.settings.quietHoursEnd, input.settings.quietHoursTimeZone)) {
      return { allow: false, reason: "quiet_hours" };
    }
  } else if (!contact?.firstInboundAt) {
    return { allow: false, reason: "no_prior_inbound" };
  }

  if (!input.testUnlimitedMode) {
    const warmup = inWarmup(input.pairedAt, input.now, input.settings.warmupDays);
    const perMinute = warmup
      ? Math.min(input.settings.messagesPerMinute, input.settings.warmupMessagesPerMinute)
      : input.settings.messagesPerMinute;
    const perHour = warmup
      ? Math.min(input.settings.messagesPerHour, input.settings.warmupMessagesPerHour)
      : input.settings.messagesPerHour;
    const perDay = warmup
      ? Math.min(input.settings.dailyCap, input.settings.warmupDailyCap)
      : input.settings.dailyCap;
    const contactPerMinute = Math.min(input.settings.perContactPerMinute, warmup ? input.settings.warmupMessagesPerMinute : input.settings.perContactPerMinute);
    const contactPerHour = Math.min(input.settings.perContactPerHour, warmup ? input.settings.warmupMessagesPerHour : input.settings.perContactPerHour);
    const contactPerDay = warmup
      ? Math.min(input.settings.perContactDailyCap, input.settings.warmupPerContactDailyCap)
      : input.settings.perContactDailyCap;

    if (input.global.minute >= perMinute) return { allow: false, reason: "rate_minute" };
    if (input.global.hour >= perHour) return { allow: false, reason: "rate_hour" };
    if (input.global.day >= perDay) return { allow: false, reason: "rate_day" };
    if (input.contactBucket.minute >= contactPerMinute) return { allow: false, reason: "contact_rate_minute" };
    if (input.contactBucket.hour >= contactPerHour) return { allow: false, reason: "contact_rate_hour" };
    if (input.contactBucket.day >= contactPerDay) return { allow: false, reason: "contact_rate_day" };
  }

  if (!input.testUnlimitedMode && text && linkCount(text) > input.settings.maxLinksPerMessage) return { allow: false, reason: "too_many_links" };

  const fingerprint = textFingerprint(text);
  const lastAt = contact?.lastOutboundAt ? Date.parse(contact.lastOutboundAt) : Number.NaN;
  const sameContact = contact?.lastOutboundText === fingerprint
    && Number.isFinite(lastAt)
    && input.now.getTime() - lastAt < input.settings.duplicateCooldownMs;
  if (!input.testUnlimitedMode) {
    if (sameContact) return { allow: false, reason: "duplicate_text" };
    if (input.recentIdenticalRecipients >= input.settings.massIdenticalLimit) {
      return { allow: false, reason: "mass_identical" };
    }
  }

  const chunks = text ? splitOutboundText(text, input.settings.maxMessageChars) : [];
  if (text && chunks.length === 0) return { allow: false, reason: "empty_text" };
  const extra = contact && contact.outboundCount === 0 ? input.settings.firstMessageExtraDelayMs : 0;
  return {
    allow: true,
    reason: "ok",
    text,
    chunks,
    delayMs: input.testUnlimitedMode ? 0 : jitterDelay(input.settings.minDelayMs, input.settings.maxDelayMs, input.random, extra),
    markRead: input.settings.markAsRead && input.kind === "reply",
    sendTyping: !input.testUnlimitedMode && input.settings.sendTyping,
    fingerprint,
    consumeNotice: notice
  };
}

export function windowStart(nowMs: number, sizeMs: number): number {
  return Math.floor(nowMs / sizeMs) * sizeMs;
}

export function bucketCount(start: number, count: number, nowMs: number, sizeMs: number): number {
  return start === windowStart(nowMs, sizeMs) ? count : 0;
}

export { minuteMs, hourMs, dayMs, normalizeForMatch };
