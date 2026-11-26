import {
  findItem,
  quoteLine,
  recomputeTotals,
  searchCatalog,
  summarizeOrder
} from "./catalog.js";
import { formatCents } from "./money.js";
import { isExplicitOrderConfirmation, isOrderCancellation } from "./intent.js";
import { normalizeText, quantityNear } from "./text.js";
import type { OrderSink } from "./sink.js";
import type {
  BusinessProfile,
  CatalogItem,
  CustomerOrder,
  FallbackPlan,
  OrderFulfillment,
  OrderLine,
  ToolResult
} from "./types.js";

export interface OrderSessionOptions {
  tenantId: string;
  conversationId: string;
  catalog: readonly CatalogItem[];
  profile: BusinessProfile;
  existing: CustomerOrder | null;
  customerText: string;
  now: () => Date;
  createId: () => string;
  sink: OrderSink;
  webhookUrl?: string;
  webhookSecret?: string;
}

function failure(error: string, message: string, changed = false): ToolResult {
  return { ok: false, error, message, changed, handoff: false };
}

function ok(message: string, changed: boolean): ToolResult {
  return { ok: true, message, changed, handoff: false };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function copyOrder(order: CustomerOrder): CustomerOrder {
  return {
    ...order,
    lines: order.lines.map((line) => ({ ...line, choices: line.choices.map((choice) => ({ ...choice })) })),
    fulfillment: order.fulfillment ? { ...order.fulfillment } : null
  };
}

export class OrderSession {
  private current: CustomerOrder | null;
  private readonly options: OrderSessionOptions;

  constructor(options: OrderSessionOptions) {
    this.options = options;
    this.current = options.existing ? copyOrder(options.existing) : null;
  }

  order(): CustomerOrder | null {
    return this.current ? copyOrder(this.current) : null;
  }

  async execute(name: string, args: unknown): Promise<ToolResult> {
    const record = asRecord(args);
    switch (name) {
      case "get_catalog":
        return ok(this.catalogMessage(this.options.catalog.filter((item) => item.available)), false);
      case "search_catalog":
        return ok(this.catalogMessage(searchCatalog(this.options.catalog, String(record.query ?? ""))), false);
      case "add_item":
        return this.addItem(String(record.itemId ?? record.id ?? ""), Number(record.quantity ?? 1), stringList(record.choiceIds ?? record.optionIds));
      case "update_item":
        return this.updateItem(String(record.lineId ?? ""), record.quantity, stringList(record.choiceIds ?? record.optionIds));
      case "remove_item":
        return this.removeItem(String(record.lineId ?? ""));
      case "set_fulfillment":
        return this.setFulfillment(String(record.method ?? ""), typeof record.address === "string" ? record.address : "", typeof record.notes === "string" ? record.notes : undefined);
      case "get_order_summary":
        return this.presentSummary();
      case "confirm_order":
        return this.confirm();
      default:
        return failure("unknown_tool", "Ferramenta desconhecida.");
    }
  }

  async applyPlan(plan: FallbackPlan): Promise<ToolResult> {
    if (plan.handoff) return { ok: true, message: "Vou encaminhar você para uma pessoa.", changed: false, handoff: true };
    if (isOrderCancellation(this.options.customerText) && this.current && this.open()) {
      this.current.status = "cancelled";
      this.current.cancelledAt = this.stamp();
      this.current.updatedAt = this.current.cancelledAt;
      return ok("Cancelei o rascunho deste pedido.", true);
    }
    let changed = false;
    const notes: string[] = [];
    for (const item of plan.items ?? []) {
      const resolved = this.resolvePlanItem(item);
      if (!resolved) continue;
      const result = this.addItem(resolved.itemId, resolved.quantity, resolved.choiceIds);
      notes.push(result.message);
      changed = changed || result.changed;
      if (!result.ok && result.error === "missing_choice") return result;
    }
    if (plan.fulfillment?.method || plan.fulfillment?.address || plan.fulfillment?.notes) {
      const method = plan.fulfillment.method === "pickup" || plan.fulfillment.method === "delivery"
        ? plan.fulfillment.method
        : this.current?.fulfillment?.method ?? (this.options.profile.deliveryEnabled ? "delivery" : "pickup");
      const result = this.setFulfillment(method, plan.fulfillment.address ?? this.current?.fulfillment?.address ?? "", plan.fulfillment.notes);
      notes.push(result.message);
      changed = changed || result.changed;
    }
    if (plan.confirm) {
      const result = await this.confirm();
      return { ...result, changed: changed || result.changed, message: result.message };
    }
    if (changed && this.current && this.ready(this.current)) return this.presentSummary();
    if (changed) return ok(notes.filter(Boolean).join("\n") || "Atualizei o pedido.", true);
    if (plan.reply?.trim()) return ok(plan.reply.trim(), false);
    if (this.current && this.current.lines.length > 0) return ok(summarizeOrder(this.current), false);
    return ok(plan.reply?.trim() || "Me diz o item, o tamanho e se é entrega ou retirada.", false);
  }

  private catalogMessage(items: readonly CatalogItem[]): string {
    if (items.length === 0) return "Nenhum item encontrado no cardápio.";
    return items.map((item) => {
      const groups = item.optionGroups.map((group) => group.choices.map((choice) => `${choice.name} [${choice.id}] ${choice.priceCents ? formatCents(choice.priceCents) : ""}`.trim()).join(", "));
      return `${item.name} [${item.id}] ${formatCents(item.priceCents)}${item.available ? "" : " indisponível"}${groups.length ? ` | ${groups.join(" | ")}` : ""}`;
    }).join("\n");
  }

  private stamp(): string {
    return this.options.now().toISOString();
  }

  private ensureDraft(): CustomerOrder | ToolResult {
    if (this.current && !this.open()) {
      return failure("order_closed", "Este pedido já foi encerrado. Posso começar outro.");
    }
    if (!this.current) {
      const now = this.stamp();
      this.current = {
        id: this.options.createId(),
        tenantId: this.options.tenantId,
        conversationId: this.options.conversationId,
        status: "draft",
        lines: [],
        fulfillment: null,
        subtotalCents: 0,
        deliveryFeeCents: 0,
        totalCents: 0,
        currency: "BRL",
        summaryPresentedAt: null,
        confirmedAt: null,
        cancelledAt: null,
        integrationReference: null,
        integrationError: null,
        createdAt: now,
        updatedAt: now
      };
    }
    return this.current;
  }

  private open(): boolean {
    return this.current?.status === "draft" || this.current?.status === "awaiting_confirmation";
  }

  private touch(order: CustomerOrder): void {
    if (order.status === "awaiting_confirmation") {
      order.status = "draft";
      order.summaryPresentedAt = null;
    }
    order.updatedAt = this.stamp();
    recomputeTotals(order, this.options.profile);
  }

  private addItem(itemId: string, quantity: number, choiceIds: string[]): ToolResult {
    const item = findItem(this.options.catalog, itemId);
    if (!item) return failure("unknown_item", "Esse item não está no cardápio.");
    const quoted = quoteLine(item, quantity, choiceIds);
    if (!quoted.ok) return failure(quoted.error, quoted.message);
    const draft = this.ensureDraft();
    if (!("lines" in draft)) return draft;
    const line: OrderLine = {
      lineId: this.options.createId(),
      itemId: item.id,
      name: quoted.name,
      quantity: quoted.quantity,
      unitPriceCents: quoted.unitPriceCents,
      choices: quoted.choices,
      lineTotalCents: quoted.lineTotalCents
    };
    draft.lines.push(line);
    this.touch(draft);
    return ok(`Adicionei ${quoted.quantity}× ${quoted.name} (${formatCents(quoted.lineTotalCents)}).`, true);
  }

  private requireOpen(): CustomerOrder | ToolResult {
    if (!this.current || !this.open()) return failure("empty_order", "Ainda não há um pedido em aberto.");
    return this.current;
  }

  private updateItem(lineId: string, quantity: unknown, choiceIds: string[]): ToolResult {
    const draft = this.requireOpen();
    if (!("lines" in draft)) return draft;
    const line = draft.lines.find((item) => item.lineId === lineId);
    if (!line) return failure("unknown_line", "Não encontrei essa linha no pedido.");
    const item = findItem(this.options.catalog, line.itemId);
    if (!item) return failure("unknown_item", "O item saiu do cardápio.");
    const nextQuantity = quantity === undefined ? line.quantity : Number(quantity);
    const nextChoices = choiceIds.length > 0 ? choiceIds : line.choices.map((choice) => choice.choiceId);
    const quoted = quoteLine(item, nextQuantity, nextChoices);
    if (!quoted.ok) return failure(quoted.error, quoted.message);
    line.quantity = quoted.quantity;
    line.unitPriceCents = quoted.unitPriceCents;
    line.choices = quoted.choices;
    line.lineTotalCents = quoted.lineTotalCents;
    this.touch(draft);
    return ok(`Atualizei ${line.name}.`, true);
  }

  private removeItem(lineId: string): ToolResult {
    const draft = this.requireOpen();
    if (!("lines" in draft)) return draft;
    const before = draft.lines.length;
    draft.lines = draft.lines.filter((line) => line.lineId !== lineId);
    if (draft.lines.length === before) return failure("unknown_line", "Não encontrei essa linha no pedido.");
    this.touch(draft);
    return ok("Removi o item do pedido.", true);
  }

  private setFulfillment(method: string, address: string, notes: string | undefined): ToolResult {
    if (method !== "delivery" && method !== "pickup") {
      return failure("invalid_fulfillment", "A forma precisa ser delivery ou pickup.");
    }
    if (method === "delivery" && !this.options.profile.deliveryEnabled) {
      return failure("delivery_disabled", "Esta empresa não faz entrega.");
    }
    if (method === "pickup" && !this.options.profile.pickupEnabled) {
      return failure("pickup_disabled", "Esta empresa não faz retirada.");
    }
    const draft = this.ensureDraft();
    if (!("lines" in draft)) return draft;
    const fulfillment: OrderFulfillment = {
      method,
      address: address.trim(),
      notes: notes !== undefined ? notes.trim() : draft.fulfillment?.notes ?? ""
    };
    draft.fulfillment = fulfillment;
    this.touch(draft);
    return ok(method === "delivery" ? "Anotei entrega." : "Anotei retirada.", true);
  }

  private ready(order: CustomerOrder): boolean {
    if (order.lines.length === 0 || !order.fulfillment) return false;
    if (order.fulfillment.method === "delivery" && !order.fulfillment.address.trim()) return false;
    return true;
  }

  private missing(order: CustomerOrder): string {
    if (order.lines.length === 0) return "O pedido ainda não tem itens.";
    if (!order.fulfillment) return "Falta dizer se é entrega ou retirada.";
    if (order.fulfillment.method === "delivery" && !order.fulfillment.address.trim()) return "Falta o endereço de entrega.";
    return "";
  }

  private presentSummary(): ToolResult {
    const draft = this.requireOpen();
    if (!("lines" in draft)) return draft;
    recomputeTotals(draft, this.options.profile);
    const missing = this.missing(draft);
    if (missing) return failure("incomplete_order", missing);
    draft.status = "awaiting_confirmation";
    draft.summaryPresentedAt = this.stamp();
    draft.updatedAt = draft.summaryPresentedAt;
    return ok(summarizeOrder(draft), true);
  }

  private async confirm(): Promise<ToolResult> {
    if (!this.current || this.current.status !== "awaiting_confirmation") {
      return failure("summary_not_presented", "Mostre o resumo e espere o cliente confirmar antes de fechar o pedido.");
    }
    if (!isExplicitOrderConfirmation(this.options.customerText)) {
      return failure("customer_has_not_confirmed", "O cliente ainda não confirmou o resumo. Não feche o pedido.");
    }
    const requoted = this.requote(this.current);
    if (!requoted.ok) return requoted;
    const missing = this.missing(this.current);
    if (missing) return failure("incomplete_order", missing);
    const now = this.stamp();
    this.current.status = "confirmed";
    this.current.confirmedAt = now;
    this.current.updatedAt = now;
    recomputeTotals(this.current, this.options.profile);
    const sink = await this.options.sink.deliver(this.current, {
      ...(this.options.webhookUrl ? { webhookUrl: this.options.webhookUrl } : {}),
      ...(this.options.webhookSecret ? { webhookSecret: this.options.webhookSecret } : {})
    });
    if (sink.delivered && this.options.webhookUrl) {
      this.current.status = "sent_to_integration";
      this.current.integrationReference = sink.reference ?? this.current.id;
      this.current.integrationError = null;
    } else if (sink.delivered) {
      this.current.integrationReference = sink.reference ?? "local";
      this.current.integrationError = null;
    } else {
      this.current.integrationError = sink.error ?? "sink_failed";
    }
    this.current.updatedAt = this.stamp();
    const total = formatCents(this.current.totalCents);
    const tail = this.current.status === "sent_to_integration"
      ? "Pedido confirmado e enviado para o sistema."
      : this.current.integrationError
        ? "Pedido confirmado e guardado. O envio para o sistema externo falhou; uma pessoa pode concluir."
        : "Pedido confirmado e guardado.";
    return ok(`${tail} Total ${total}.`, true);
  }

  private requote(order: CustomerOrder): ToolResult {
    for (const line of order.lines) {
      const item = findItem(this.options.catalog, line.itemId);
      if (!item) return failure("unknown_item", "Um item do pedido saiu do cardápio.");
      const quoted = quoteLine(item, line.quantity, line.choices.map((choice) => choice.choiceId));
      if (!quoted.ok) return failure(quoted.error, quoted.message);
      line.name = quoted.name;
      line.unitPriceCents = quoted.unitPriceCents;
      line.choices = quoted.choices;
      line.lineTotalCents = quoted.lineTotalCents;
    }
    recomputeTotals(order, this.options.profile);
    return ok("Preços recalculados.", false);
  }

  private resolvePlanItem(item: FallbackPlan["items"] extends Array<infer T> | undefined ? T : never): { itemId: string; quantity: number; choiceIds: string[] } | undefined {
    const byId = item.itemId ? findItem(this.options.catalog, item.itemId) : undefined;
    const byName = !byId && item.name
      ? this.options.catalog.find((entry) => normalizeText(entry.name) === normalizeText(item.name ?? "") && entry.available)
      : undefined;
    const catalogItem = byId ?? byName;
    if (!catalogItem) return undefined;
    const choiceIds = [...(item.choiceIds ?? [])];
    for (const label of item.choices ?? []) {
      const normalized = normalizeText(label);
      for (const group of catalogItem.optionGroups) {
        const choice = group.choices.find((entry) => normalizeText(entry.name) === normalized || entry.id === label);
        if (choice && !choiceIds.includes(choice.id)) choiceIds.push(choice.id);
      }
    }
    return { itemId: catalogItem.id, quantity: item.quantity && item.quantity > 0 ? item.quantity : 1, choiceIds };
  }
}

function itemScore(item: CatalogItem, normalized: string): number {
  const name = normalizeText(item.name);
  if (name.length >= 3 && normalized.includes(name)) return 100 + name.length;
  const tokens = name.split(" ").filter((token) => token.length >= 4);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((token) => normalized.includes(token));
  if (hits.length === tokens.length) return 70 + tokens.join(" ").length;
  const distinctive = [...tokens].sort((left, right) => right.length - left.length)[0];
  if (!distinctive || distinctive.length < 5 || !normalized.includes(distinctive)) return 0;
  const rivals = 0;
  return rivals === 0 ? 40 + distinctive.length : 0;
}

export function inferPlanFromText(text: string, catalog: readonly CatalogItem[], profile: BusinessProfile): FallbackPlan {
  const normalized = normalizeText(text);
  const available = catalog.filter((item) => item.available);
  const ranked = available
    .map((item) => ({ item, score: itemScore(item, normalized) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  const items: NonNullable<FallbackPlan["items"]> = [];
  const usedTokens = new Set<string>();
  for (const entry of ranked) {
    const distinctive = normalizeText(entry.item.name).split(" ").sort((left, right) => right.length - left.length)[0] ?? "";
    if (distinctive && usedTokens.has(distinctive)) continue;
    const sameToken = ranked.filter((candidate) => normalizeText(candidate.item.name).includes(distinctive) && candidate.score < 100);
    if (entry.score < 100 && sameToken.filter((candidate) => candidate.item.id !== entry.item.id && candidate.score === entry.score).length > 0) {
      continue;
    }
    if (distinctive) usedTokens.add(distinctive);
    const choiceIds: string[] = [];
    const choiceNames: string[] = [];
    for (const group of entry.item.optionGroups) {
      const matched = group.choices.find((choice) => normalized.includes(normalizeText(choice.name)));
      const fallback = group.required ? group.choices.find((choice) => choice.priceCents === 0) ?? group.choices[0] : undefined;
      const choice = matched ?? fallback;
      if (choice) {
        choiceIds.push(choice.id);
        choiceNames.push(choice.name);
      }
    }
    items.push({
      itemId: entry.item.id,
      quantity: quantityNear(text, entry.item.name) || quantityNear(text, distinctive),
      choiceIds,
      choices: choiceNames
    });
  }
  let method: "delivery" | "pickup" | undefined;
  if (/\b(?:entrega|delivery|entregar)\b/.test(normalized) && profile.deliveryEnabled) method = "delivery";
  else if (/\b(?:retirada|retirar|buscar|balcao)\b/.test(normalized) && profile.pickupEnabled) method = "pickup";
  const addressMatch = /(?:endereco|rua|avenida|av |travessa|alameda)\s+(.{5,160})$/i.exec(text.trim());
  const address = addressMatch?.[1]?.replace(/\s+(?:obs|observacao)\b[\s\S]*$/i, "").trim();
  return {
    confirm: isExplicitOrderConfirmation(text),
    items,
    ...(method || address ? { fulfillment: { ...(method ? { method } : {}), ...(address ? { address } : {}) } } : {})
  };
}
