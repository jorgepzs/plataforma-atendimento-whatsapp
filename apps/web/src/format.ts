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
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.includes(",") ? trimmed.replace(/\./g, "").replace(",", ".") : trimmed;
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return undefined;
  return Math.round(Number(normalized) * 100);
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
