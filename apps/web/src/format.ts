import type { BusinessProfile, CatalogItem, TenantConfig } from "./api";

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(cents));
  const reais = String(Math.floor(absolute / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${sign}R$ ${reais},${fraction}`;
}

export function centsToInput(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)},${String(absolute % 100).padStart(2, "0")}`;
}

export function inputToCents(value: string): number | undefined {
  const trimmed = value.trim().replace(/^r\$\s*/i, "").replace(/\s/g, "");
  if (!trimmed) return undefined;
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const normalized = body.includes(",") ? body.replace(/\./g, "").replace(",", ".") : body;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return undefined;
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents)) return undefined;
  return negative ? -cents : cents;
}

export function centsFromTyping(value: string, signed = false): number | undefined {
  const negative = signed && value.trim().startsWith("-");
  const digits = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (!digits) return 0;
  if (digits.length > 8) return undefined;
  const cents = Number(digits);
  if (!Number.isSafeInteger(cents) || cents > 1_000_000) return undefined;
  return negative ? -cents : cents;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "item";
}

export function uniqueId(base: string, used: Set<string>): string {
  let id = slugify(base);
  let suffix = 2;
  while (used.has(id)) {
    id = `${slugify(base).slice(0, 36)}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

export function emptyProfile(): BusinessProfile {
  return {
    address: "",
    serviceArea: "",
    hours: "",
    deliveryEnabled: false,
    pickupEnabled: false,
    deliveryFeeCents: 0,
    paymentMethods: [],
    policies: "",
    persona: ""
  };
}

export function normalizeConfig(config: TenantConfig): TenantConfig {
  return {
    ...config,
    assistantObjective: typeof config.assistantObjective === "string" ? config.assistantObjective : "",
    profile: { ...emptyProfile(), ...config.profile },
    catalog: config.catalog ?? [],
    orderingEnabled: config.orderingEnabled === true,
    knowledge: config.knowledge ?? [],
    handoffKeywords: config.handoffKeywords ?? []
  };
}

export function isToday(value: string): boolean {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export const orderStatusLabels: Record<string, string> = {
  draft: "Rascunho",
  awaiting_confirmation: "Aguardando confirmação",
  confirmed: "Confirmado",
  sent_to_integration: "Enviado",
  cancelled: "Cancelado"
};

export function normalizePhoneDigits(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length > 11) return digits.slice(0, 13);
  return digits.slice(0, 11);
}

export function formatPhoneBR(input: string): string {
  const digits = normalizePhoneDigits(input);
  const national = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
  if (!national) return digits.startsWith("55") ? "+55" : "";
  const ddd = national.slice(0, 2);
  const number = national.slice(2);
  let formatted = "+55";
  if (ddd) formatted += ` (${ddd}`;
  if (national.length >= 2) formatted += ")";
  if (number.length > 4) formatted += ` ${number.slice(0, number.length - 4)}-${number.slice(-4)}`;
  else if (number) formatted += ` ${number}`;
  return formatted;
}

export function isCompletePhoneBR(input: string): boolean {
  const digits = normalizePhoneDigits(input);
  const national = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
  if (national.length === 11) return /^[1-9]{2}9\d{8}$/.test(national);
  if (national.length === 10) return /^[1-9]{2}[2-5]\d{7}$/.test(national);
  return false;
}

export function phoneForApi(input: string): string {
  const digits = normalizePhoneDigits(input);
  if (!digits) return "";
  if (digits.startsWith("55") && digits.length > 11) return digits;
  return `55${digits}`;
}

export function maskCep(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

export function isCompleteCep(input: string): boolean {
  return /^\d{8}$/.test(input.replace(/\D/g, ""));
}

export function maskCpf(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, 11);
  return digits
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

export function maskCnpj(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, 14);
  return digits
    .replace(/(\d{2})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1/$2")
    .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
}

function checkDigit(digits: string, length: number, weights: number[]): number {
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += Number(digits[index]) * (weights[index] ?? 0);
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function isValidCpf(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const weights = [10, 9, 8, 7, 6, 5, 4, 3, 2];
  const first = checkDigit(digits, 9, weights);
  const second = checkDigit(digits, 10, [11, ...weights]);
  return first === Number(digits[9]) && second === Number(digits[10]);
}

export function isValidCnpj(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
  const firstWeights = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const first = checkDigit(digits, 12, firstWeights);
  const second = checkDigit(digits, 13, [6, ...firstWeights]);
  return first === Number(digits[12]) && second === Number(digits[13]);
}

export function maskDocument(input: string): string {
  const digits = input.replace(/\D/g, "");
  return digits.length > 11 ? maskCnpj(digits) : maskCpf(digits);
}

export function documentError(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 11) {
    if (digits.length < 11) return "CPF incompleto.";
    return isValidCpf(digits) ? "" : "CPF inválido.";
  }
  if (digits.length < 14) return "CNPJ incompleto.";
  return isValidCnpj(digits) ? "" : "CNPJ inválido.";
}

export function maskTime(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

export function isValidTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function maskPercent(input: string): string {
  const cleaned = input.replace("%", "").trim().replace(/[^\d,]/g, "");
  const [whole = "", fraction] = cleaned.split(",");
  const normalized = whole.replace(/^0+(?=\d)/, "").slice(0, 3);
  if (fraction === undefined) return normalized;
  return `${normalized || "0"},${fraction.slice(0, 2)}`;
}

export function parsePercent(input: string): number | undefined {
  const normalized = input.trim().replace("%", "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return undefined;
  const value = Number(normalized);
  if (value < 0 || value > 100) return undefined;
  return value;
}

export const weekdays = [
  { key: "seg", label: "Segunda" },
  { key: "ter", label: "Terça" },
  { key: "qua", label: "Quarta" },
  { key: "qui", label: "Quinta" },
  { key: "sex", label: "Sexta" },
  { key: "sab", label: "Sábado" },
  { key: "dom", label: "Domingo" }
] as const;

export type WeekdayKey = (typeof weekdays)[number]["key"];

export interface DaySchedule {
  key: WeekdayKey;
  closed: boolean;
  open: string;
  close: string;
}

export function defaultWeek(open = "18:00", close = "23:00"): DaySchedule[] {
  return weekdays.map((day) => ({ key: day.key, closed: false, open, close }));
}

export function serializeHours(days: DaySchedule[]): string {
  return days.map((day) => `${day.key} ${day.closed ? "fechado" : `${day.open}-${day.close}`}`).join("; ");
}

export function parseHours(value: string): { structured: true; days: DaySchedule[] } | { structured: false; text: string } {
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== weekdays.length) return { structured: false, text: value };
  const days: DaySchedule[] = [];
  for (let index = 0; index < weekdays.length; index += 1) {
    const day = weekdays[index];
    const match = /^(seg|ter|qua|qui|sex|sab|dom) (fechado|(\d{2}:\d{2})-(\d{2}:\d{2}))$/.exec(parts[index] ?? "");
    if (!day || !match || match[1] !== day.key) return { structured: false, text: value };
    if (match[2] === "fechado") {
      days.push({ key: day.key, closed: true, open: "18:00", close: "23:00" });
      continue;
    }
    const open = match[3] ?? "";
    const close = match[4] ?? "";
    if (!isValidTime(open) || !isValidTime(close) || open >= close) return { structured: false, text: value };
    days.push({ key: day.key, closed: false, open, close });
  }
  return { structured: true, days };
}

export function hoursError(days: DaySchedule[]): string {
  for (const day of days) {
    if (day.closed) continue;
    const label = weekdays.find((item) => item.key === day.key)?.label ?? day.key;
    if (!isValidTime(day.open) || !isValidTime(day.close)) return `${label}: use o horário HH:MM.`;
    if (day.open >= day.close) return `${label}: o fechamento precisa ser depois da abertura.`;
  }
  return "";
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  const value = `${first}${second}`.toLocaleUpperCase("pt-BR");
  return value || "?";
}

const avatarPalette = ["#1f7a4d", "#0f6e56", "#175cd3", "#b54708", "#9f1239", "#6941c6", "#0e7490"];

export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return avatarPalette[hash % avatarPalette.length] ?? "#1f7a4d";
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatDayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const that = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((start - that) / 86_400_000);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Ontem";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(date).replace(".", "");
}

export function formatListTime(iso: string, now = new Date()): string {
  const label = formatDayLabel(iso, now);
  if (label === "Hoje") return formatClock(iso);
  return label;
}

export type DeliveryTick = "fila" | "enviada" | "entregue" | "lida" | "falha" | "painel";

export function deliveryTick(status: string, detail?: string | null): { tick: DeliveryTick; label: string } {
  if (status === "PENDING" || status === "SENDING") return { tick: "fila", label: "Na fila" };
  if (status === "ACCEPTED" && detail === "read") return { tick: "lida", label: "Lida" };
  if (status === "ACCEPTED" && detail === "delivered") return { tick: "entregue", label: "Entregue" };
  if (status === "ACCEPTED") return { tick: "enviada", label: "Enviada" };
  if (status === "BLOCKED" || status === "HTTP_ERROR" || status === "INDETERMINATE") return { tick: "falha", label: "Falha" };
  if (status === "SIMULATED") return { tick: "painel", label: "Só no painel" };
  return { tick: "enviada", label: status };
}

export async function lookupCep(input: string): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const digits = input.replace(/\D/g, "");
  if (digits.length !== 8) return { ok: false, error: "CEP deve ter 8 dígitos." };
  try {
    const response = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
    if (!response.ok) return { ok: false, error: "Não foi possível consultar o CEP." };
    const data = await response.json() as {
      erro?: boolean;
      logradouro?: string;
      bairro?: string;
      localidade?: string;
      uf?: string;
    };
    if (data.erro) return { ok: false, error: "CEP não encontrado." };
    const city = data.localidade && data.uf ? `${data.localidade} - ${data.uf}` : data.localidade ?? "";
    const address = [data.logradouro, data.bairro, city].filter(Boolean).join(", ");
    if (!address) return { ok: false, error: "CEP sem endereço." };
    return { ok: true, address: `${address}, ${maskCep(digits)}` };
  } catch {
    return { ok: false, error: "Não foi possível consultar o CEP. Preencha o endereço manualmente." };
  }
}

export function blankItem(catalog: CatalogItem[]): CatalogItem {
  const used = new Set(catalog.map((item) => item.id));
  return {
    id: uniqueId("item", used),
    name: "",
    description: "",
    priceCents: 0,
    category: "",
    available: true,
    optionGroups: []
  };
}
