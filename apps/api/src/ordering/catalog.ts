import { formatCents } from "./money.js";
import { normalizeText } from "./text.js";
import type { BusinessProfile, CatalogItem, CustomerOrder, OrderChoice, OrderLine } from "./types.js";

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
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

export function copyProfile(profile: BusinessProfile | undefined): BusinessProfile {
  const base = emptyProfile();
  if (!profile) return base;
  return {
    address: profile.address?.trim() ?? "",
    serviceArea: profile.serviceArea?.trim() ?? "",
    hours: profile.hours?.trim() ?? "",
    deliveryEnabled: profile.deliveryEnabled === true,
    pickupEnabled: profile.pickupEnabled === true,
    deliveryFeeCents: Number.isSafeInteger(profile.deliveryFeeCents) ? profile.deliveryFeeCents : 0,
    paymentMethods: Array.isArray(profile.paymentMethods) ? profile.paymentMethods.map((item) => item.trim()).filter(Boolean) : [],
    policies: profile.policies?.trim() ?? "",
    persona: profile.persona?.trim() ?? ""
  };
}

export function copyCatalog(items: readonly CatalogItem[] | undefined): CatalogItem[] {
  if (!items) return [];
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description ?? "",
    priceCents: item.priceCents,
    category: item.category ?? "",
    available: item.available !== false,
    optionGroups: (item.optionGroups ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      required: group.required === true,
      minSelections: group.minSelections,
      maxSelections: group.maxSelections,
      choices: group.choices.map((choice) => ({
        id: choice.id,
        name: choice.name,
        priceCents: choice.priceCents
      }))
    }))
  }));
}

export function assertCatalog(items: readonly CatalogItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new CatalogError(`Item duplicado: ${item.id}.`);
    ids.add(item.id);
    if (!item.name.trim()) throw new CatalogError("Item sem nome.");
    if (!Number.isSafeInteger(item.priceCents) || item.priceCents < 0) {
      throw new CatalogError(`Preço inválido em ${item.name}.`);
    }
    const choiceIds = new Set<string>();
    for (const group of item.optionGroups) {
      if (group.minSelections > group.maxSelections) {
        throw new CatalogError(`Grupo ${group.name} tem mínimo maior que o máximo.`);
      }
      if (group.required && group.minSelections < 1) {
        throw new CatalogError(`Grupo obrigatório ${group.name} precisa de ao menos uma escolha.`);
      }
      for (const choice of group.choices) {
        if (choiceIds.has(choice.id)) throw new CatalogError(`Opção duplicada: ${choice.id}.`);
        choiceIds.add(choice.id);
        if (!Number.isSafeInteger(choice.priceCents)) throw new CatalogError(`Preço inválido em ${choice.name}.`);
      }
    }
  }
}

export function findItem(catalog: readonly CatalogItem[], itemId: string): CatalogItem | undefined {
  return catalog.find((item) => item.id === itemId);
}

export function searchCatalog(catalog: readonly CatalogItem[], query: string): CatalogItem[] {
  const normalized = normalizeText(query);
  if (!normalized) return catalog.filter((item) => item.available).slice(0, 20);
  const tokens = normalized.split(" ").filter((token) => token.length > 1);
  return catalog.filter((item) => {
    const haystack = normalizeText(`${item.name} ${item.category} ${item.description}`);
    return tokens.every((token) => haystack.includes(token)) || haystack.includes(normalized);
  }).slice(0, 20);
}

export function quoteLine(
  item: CatalogItem,
  quantity: number,
  choiceIds: readonly string[]
): { ok: true; name: string; quantity: number; unitPriceCents: number; choices: OrderChoice[]; lineTotalCents: number } | { ok: false; error: string; message: string } {
  if (!item.available) return { ok: false, error: "unavailable", message: `${item.name} não está disponível.` };
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
    return { ok: false, error: "invalid_quantity", message: "A quantidade precisa ser um inteiro de 1 a 20." };
  }
  if (new Set(choiceIds).size !== choiceIds.length) {
    return { ok: false, error: "duplicate_choice", message: "Há opções repetidas no item." };
  }
  const located = new Map<string, { groupId: string; choice: CatalogItem["optionGroups"][number]["choices"][number] }>();
  for (const group of item.optionGroups) {
    for (const choice of group.choices) located.set(choice.id, { groupId: group.id, choice });
  }
  const choices: OrderChoice[] = [];
  for (const choiceId of choiceIds) {
    const found = located.get(choiceId);
    if (!found) return { ok: false, error: "unknown_choice", message: `A opção ${choiceId} não existe em ${item.name}.` };
    choices.push({
      groupId: found.groupId,
      choiceId: found.choice.id,
      name: found.choice.name,
      priceCents: found.choice.priceCents
    });
  }
  for (const group of item.optionGroups) {
    const count = choices.filter((choice) => choice.groupId === group.id).length;
    const minimum = group.required ? Math.max(group.minSelections, 1) : group.minSelections;
    if (count < minimum) {
      const options = group.choices.map((choice) => `${choice.id} (${choice.name})`).join(", ");
      return { ok: false, error: "missing_choice", message: `Falta escolher ${group.name}. Opções: ${options}.` };
    }
    if (count > group.maxSelections) {
      return { ok: false, error: "too_many_choices", message: `Há escolhas demais em ${group.name}.` };
    }
  }
  const unitPriceCents = item.priceCents + choices.reduce((total, choice) => total + choice.priceCents, 0);
  if (unitPriceCents < 0) return { ok: false, error: "invalid_price", message: "O preço calculado ficou negativo." };
  return {
    ok: true,
    name: item.name,
    quantity,
    unitPriceCents,
    choices,
    lineTotalCents: unitPriceCents * quantity
  };
}

export function recomputeTotals(order: CustomerOrder, profile: BusinessProfile): void {
  order.subtotalCents = order.lines.reduce((total, line) => total + line.lineTotalCents, 0);
  order.deliveryFeeCents = order.fulfillment?.method === "delivery" ? profile.deliveryFeeCents : 0;
  order.totalCents = order.subtotalCents + order.deliveryFeeCents;
}

export function describeLine(line: OrderLine): string {
  const options = line.choices.length > 0 ? ` (${line.choices.map((choice) => choice.name).join(", ")})` : "";
  return `${line.quantity}× ${line.name}${options} — ${formatCents(line.lineTotalCents)}`;
}

export function summarizeOrder(order: CustomerOrder): string {
  if (order.lines.length === 0) return "O pedido ainda está vazio.";
  const lines = order.lines.map((line, index) => `${index + 1}. ${describeLine(line)}`);
  const fulfillment = !order.fulfillment
    ? "Entrega ou retirada ainda não definida."
    : order.fulfillment.method === "delivery"
      ? `Entrega${order.fulfillment.address ? `: ${order.fulfillment.address}` : " sem endereço"}.`
      : "Retirada no balcão.";
  const notes = order.fulfillment?.notes ? `Obs.: ${order.fulfillment.notes}` : "";
  const fee = order.deliveryFeeCents > 0 ? `Taxa de entrega: ${formatCents(order.deliveryFeeCents)}` : "";
  return [
    "Resumo do pedido:",
    ...lines,
    fulfillment,
    fee,
    `Total: ${formatCents(order.totalCents)}`,
    "Se estiver certo, responda SIM para eu confirmar. Se quiser mudar algo, é só dizer."
  ].filter(Boolean).join("\n");
}

export function catalogBrief(items: readonly CatalogItem[]): string {
  return items.slice(0, 80).map((item) => {
    const groups = item.optionGroups.map((group) => {
      const choices = group.choices.map((choice) => `${choice.id}:${choice.name}${choice.priceCents ? ` ${formatCents(choice.priceCents)}` : ""}`).join(", ");
      return `${group.name}${group.required ? " (obrigatório)" : ""}: ${choices}`;
    }).join("; ");
    const availability = item.available ? "" : " [indisponível]";
    return `- ${item.id} | ${item.name}${availability} | ${formatCents(item.priceCents)}${item.category ? ` | ${item.category}` : ""}${groups ? ` | ${groups}` : ""}`;
  }).join("\n");
}
