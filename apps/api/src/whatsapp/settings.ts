import { z } from "zod";
import type { WhatsAppProviderId } from "./types.js";

const defaultOptOutKeywords = ["sair", "parar", "stop", "cancelar", "descadastrar"];

export interface AntiBanSettings {
  proactiveEnabled: boolean;
  messagesPerMinute: number;
  messagesPerHour: number;
  dailyCap: number;
  perContactPerMinute: number;
  perContactPerHour: number;
  perContactDailyCap: number;
  minDelayMs: number;
  maxDelayMs: number;
  firstMessageExtraDelayMs: number;
  typingMsPerChar: number;
  typingMinMs: number;
  typingMaxMs: number;
  maxMessageChars: number;
  maxLinksPerMessage: number;
  duplicateCooldownMs: number;
  massIdenticalLimit: number;
  massIdenticalWindowMs: number;
  warmupDays: number;
  warmupMessagesPerMinute: number;
  warmupMessagesPerHour: number;
  warmupDailyCap: number;
  warmupPerContactDailyCap: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  quietHoursTimeZone: string;
  optOutKeywords: string[];
  markAsRead: boolean;
  sendTyping: boolean;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export interface AntiBanOverride {
  proactiveEnabled?: boolean;
  messagesPerMinute?: number;
  messagesPerHour?: number;
  dailyCap?: number;
  perContactPerMinute?: number;
  perContactPerHour?: number;
  perContactDailyCap?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  firstMessageExtraDelayMs?: number;
  maxMessageChars?: number;
  maxLinksPerMessage?: number;
  warmupDays?: number;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimeZone?: string;
  optOutKeywords?: string[];
}

export interface WhatsAppChannelConfig {
  enabled: boolean;
  provider: WhatsAppProviderId;
  sessionDir?: string;
  stateDir?: string;
  alertWebhookUrl?: string;
  metaPhoneNumberId?: string;
  metaAccessToken?: string;
  panelOrigins: string[];
  antiBan: AntiBanSettings;
}

export function defaultAntiBanSettings(): AntiBanSettings {
  return {
    proactiveEnabled: false,
    messagesPerMinute: 4,
    messagesPerHour: 30,
    dailyCap: 120,
    perContactPerMinute: 2,
    perContactPerHour: 6,
    perContactDailyCap: 15,
    minDelayMs: 3_000,
    maxDelayMs: 8_000,
    firstMessageExtraDelayMs: 12_000,
    typingMsPerChar: 35,
    typingMinMs: 1_500,
    typingMaxMs: 7_000,
    maxMessageChars: 800,
    maxLinksPerMessage: 1,
    duplicateCooldownMs: 60 * 60 * 1_000,
    massIdenticalLimit: 8,
    massIdenticalWindowMs: 30 * 60 * 1_000,
    warmupDays: 7,
    warmupMessagesPerMinute: 1,
    warmupMessagesPerHour: 8,
    warmupDailyCap: 25,
    warmupPerContactDailyCap: 6,
    quietHoursStart: 21,
    quietHoursEnd: 8,
    quietHoursTimeZone: "America/Sao_Paulo",
    optOutKeywords: [...defaultOptOutKeywords],
    markAsRead: true,
    sendTyping: true,
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 5 * 60 * 1_000
  };
}

export function disabledWhatsAppConfig(): WhatsAppChannelConfig {
  return {
    enabled: false,
    provider: "unofficial_qr",
    panelOrigins: [],
    antiBan: defaultAntiBanSettings()
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function clampAntiBan(settings: AntiBanSettings): AntiBanSettings {
  const minDelayMs = clamp(settings.minDelayMs, 500, 60_000);
  const maxDelayMs = Math.max(minDelayMs, clamp(settings.maxDelayMs, 500, 120_000));
  const timeZone = isValidTimeZone(settings.quietHoursTimeZone) ? settings.quietHoursTimeZone : "America/Sao_Paulo";
  const keywords = [...new Set([...defaultOptOutKeywords, ...settings.optOutKeywords.map((keyword) => keyword.trim()).filter(Boolean)])];
  return {
    ...settings,
    messagesPerMinute: clamp(settings.messagesPerMinute, 1, 20),
    messagesPerHour: clamp(settings.messagesPerHour, 1, 200),
    dailyCap: clamp(settings.dailyCap, 10, 500),
    perContactPerMinute: clamp(settings.perContactPerMinute, 1, 5),
    perContactPerHour: clamp(settings.perContactPerHour, 1, 30),
    perContactDailyCap: clamp(settings.perContactDailyCap, 1, 40),
    minDelayMs,
    maxDelayMs,
    firstMessageExtraDelayMs: clamp(settings.firstMessageExtraDelayMs, 0, 120_000),
    typingMsPerChar: clamp(settings.typingMsPerChar, 10, 200),
    typingMinMs: clamp(settings.typingMinMs, 400, 15_000),
    typingMaxMs: clamp(settings.typingMaxMs, 1_000, 20_000),
    maxMessageChars: clamp(settings.maxMessageChars, 200, 1_500),
    maxLinksPerMessage: clamp(settings.maxLinksPerMessage, 0, 2),
    duplicateCooldownMs: clamp(settings.duplicateCooldownMs, 60_000, 24 * 60 * 60 * 1_000),
    massIdenticalLimit: clamp(settings.massIdenticalLimit, 2, 20),
    massIdenticalWindowMs: clamp(settings.massIdenticalWindowMs, 60_000, 24 * 60 * 60 * 1_000),
    warmupDays: clamp(settings.warmupDays, 1, 30),
    warmupMessagesPerMinute: clamp(settings.warmupMessagesPerMinute, 1, 5),
    warmupMessagesPerHour: clamp(settings.warmupMessagesPerHour, 1, 40),
    warmupDailyCap: clamp(settings.warmupDailyCap, 5, 80),
    warmupPerContactDailyCap: clamp(settings.warmupPerContactDailyCap, 1, 15),
    quietHoursStart: clamp(settings.quietHoursStart, 0, 23),
    quietHoursEnd: clamp(settings.quietHoursEnd, 0, 23),
    quietHoursTimeZone: timeZone,
    optOutKeywords: keywords,
    reconnectBaseMs: clamp(settings.reconnectBaseMs, 1_000, 60_000),
    reconnectMaxMs: clamp(settings.reconnectMaxMs, 30_000, 30 * 60 * 1_000)
  };
}

export function mergeAntiBan(base: AntiBanSettings, override: AntiBanOverride | undefined): AntiBanSettings {
  if (!override) return clampAntiBan(base);
  return clampAntiBan({
    ...base,
    ...override,
    optOutKeywords: override.optOutKeywords ?? base.optOutKeywords
  });
}

const optionalInt = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().int().optional()
);

const whatsappEnvSchema = z.object({
  WHATSAPP_CHANNEL_ENABLED: z.preprocess((value) => {
    if (typeof value !== "string" || value === "") return false;
    const normalized = value.toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return value;
  }, z.boolean()),
  WHATSAPP_PROVIDER: z.preprocess(
    (value) => (value === "" || value === undefined ? "unofficial_qr" : value),
    z.enum(["unofficial_qr", "meta_cloud"])
  ),
  WHATSAPP_SESSION_DIR: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
  WHATSAPP_STATE_DIR: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
  WHATSAPP_ALERT_WEBHOOK_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
  WHATSAPP_META_PHONE_NUMBER_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().regex(/^[1-9]\d{0,31}$/).optional()
  ),
  WHATSAPP_META_ACCESS_TOKEN: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).max(8_192).optional()),
  WHATSAPP_PANEL_ORIGINS: z.preprocess((value) => (value === "" ? undefined : value), z.string().max(2_000).optional()),
  WHATSAPP_PROACTIVE_ENABLED: z.preprocess((value) => {
    if (value === "" || value === undefined) return false;
    if (typeof value !== "string") return value;
    const normalized = value.toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return value;
  }, z.boolean()),
  WHATSAPP_MESSAGES_PER_MINUTE: optionalInt,
  WHATSAPP_MESSAGES_PER_HOUR: optionalInt,
  WHATSAPP_DAILY_CAP: optionalInt,
  WHATSAPP_MIN_DELAY_MS: optionalInt,
  WHATSAPP_MAX_DELAY_MS: optionalInt,
  WHATSAPP_FIRST_MESSAGE_DELAY_MS: optionalInt,
  WHATSAPP_WARMUP_DAYS: optionalInt,
  WHATSAPP_QUIET_START: optionalInt,
  WHATSAPP_QUIET_END: optionalInt,
  WHATSAPP_TIME_ZONE: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).max(80).optional()),
  WHATSAPP_MAX_LINKS: optionalInt
});

function panelOrigins(value: string | undefined): string[] {
  if (!value) return [];
  const origins = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("WHATSAPP_PANEL_ORIGINS contém uma origem inválida.");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("WHATSAPP_PANEL_ORIGINS deve listar origens HTTP(S) sem caminho, consulta ou credencial.");
    }
  }
  return [...new Set(origins.map((origin) => origin.replace(/\/$/, "")))];
}

function assertWebhook(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WHATSAPP_ALERT_WEBHOOK_URL é inválida.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("WHATSAPP_ALERT_WEBHOOK_URL deve usar HTTP ou HTTPS.");
  }
  if (url.username || url.password) throw new Error("WHATSAPP_ALERT_WEBHOOK_URL não pode conter credenciais.");
  return url.toString();
}

export function loadWhatsAppConfig(environment: NodeJS.ProcessEnv): WhatsAppChannelConfig {
  const parsed = whatsappEnvSchema.parse(environment);
  if (parsed.WHATSAPP_META_ACCESS_TOKEN && /\s/.test(parsed.WHATSAPP_META_ACCESS_TOKEN)) {
    throw new Error("WHATSAPP_META_ACCESS_TOKEN tem formato inválido.");
  }
  const base = defaultAntiBanSettings();
  const antiBan = clampAntiBan({
    ...base,
    proactiveEnabled: parsed.WHATSAPP_PROACTIVE_ENABLED,
    ...(parsed.WHATSAPP_MESSAGES_PER_MINUTE !== undefined ? { messagesPerMinute: parsed.WHATSAPP_MESSAGES_PER_MINUTE } : {}),
    ...(parsed.WHATSAPP_MESSAGES_PER_HOUR !== undefined ? { messagesPerHour: parsed.WHATSAPP_MESSAGES_PER_HOUR } : {}),
    ...(parsed.WHATSAPP_DAILY_CAP !== undefined ? { dailyCap: parsed.WHATSAPP_DAILY_CAP } : {}),
    ...(parsed.WHATSAPP_MIN_DELAY_MS !== undefined ? { minDelayMs: parsed.WHATSAPP_MIN_DELAY_MS } : {}),
    ...(parsed.WHATSAPP_MAX_DELAY_MS !== undefined ? { maxDelayMs: parsed.WHATSAPP_MAX_DELAY_MS } : {}),
    ...(parsed.WHATSAPP_FIRST_MESSAGE_DELAY_MS !== undefined ? { firstMessageExtraDelayMs: parsed.WHATSAPP_FIRST_MESSAGE_DELAY_MS } : {}),
    ...(parsed.WHATSAPP_WARMUP_DAYS !== undefined ? { warmupDays: parsed.WHATSAPP_WARMUP_DAYS } : {}),
    ...(parsed.WHATSAPP_QUIET_START !== undefined ? { quietHoursStart: parsed.WHATSAPP_QUIET_START } : {}),
    ...(parsed.WHATSAPP_QUIET_END !== undefined ? { quietHoursEnd: parsed.WHATSAPP_QUIET_END } : {}),
    ...(parsed.WHATSAPP_TIME_ZONE ? { quietHoursTimeZone: parsed.WHATSAPP_TIME_ZONE } : {}),
    ...(parsed.WHATSAPP_MAX_LINKS !== undefined ? { maxLinksPerMessage: parsed.WHATSAPP_MAX_LINKS } : {})
  });
  const sessionDir = parsed.WHATSAPP_SESSION_DIR;
  const stateDir = parsed.WHATSAPP_STATE_DIR ?? (sessionDir ? `${sessionDir.replace(/\/$/, "")}-state` : undefined);
  const alertWebhookUrl = assertWebhook(parsed.WHATSAPP_ALERT_WEBHOOK_URL);
  return {
    enabled: parsed.WHATSAPP_CHANNEL_ENABLED,
    provider: parsed.WHATSAPP_PROVIDER,
    panelOrigins: panelOrigins(parsed.WHATSAPP_PANEL_ORIGINS),
    antiBan,
    ...(sessionDir ? { sessionDir } : {}),
    ...(stateDir ? { stateDir } : {}),
    ...(alertWebhookUrl ? { alertWebhookUrl } : {}),
    ...(parsed.WHATSAPP_META_PHONE_NUMBER_ID ? { metaPhoneNumberId: parsed.WHATSAPP_META_PHONE_NUMBER_ID } : {}),
    ...(parsed.WHATSAPP_META_ACCESS_TOKEN ? { metaAccessToken: parsed.WHATSAPP_META_ACCESS_TOKEN } : {})
  };
}

export function publicAntiBan(settings: AntiBanSettings): AntiBanSettings {
  return { ...settings, optOutKeywords: [...settings.optOutKeywords] };
}
