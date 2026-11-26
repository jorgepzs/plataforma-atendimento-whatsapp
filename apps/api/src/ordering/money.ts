import type { BusinessProfile, CatalogItem, CustomerOrder } from "./types.js";

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(cents));
  const reais = String(Math.floor(absolute / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${sign}R$ ${reais},${fraction}`;
}

export function allowedAmounts(
  catalog: readonly CatalogItem[],
  profile: BusinessProfile,
  order: CustomerOrder | null
): Set<number> {
  const amounts = new Set<number>([0, profile.deliveryFeeCents]);
  for (const item of catalog) {
    amounts.add(item.priceCents);
    for (const group of item.optionGroups) {
      for (const choice of group.choices) {
        amounts.add(choice.priceCents);
        amounts.add(Math.abs(choice.priceCents));
        amounts.add(item.priceCents + choice.priceCents);
      }
    }
  }
  if (order) {
    amounts.add(order.subtotalCents);
    amounts.add(order.deliveryFeeCents);
    amounts.add(order.totalCents);
    for (const line of order.lines) {
      amounts.add(line.unitPriceCents);
      amounts.add(line.lineTotalCents);
      for (const choice of line.choices) amounts.add(choice.priceCents);
    }
  }
  return amounts;
}

const moneyPattern = /r\$\s*(\d{1,6})(?:[.,](\d{1,2}))?|\b(\d{1,6})(?:[.,](\d{2}))?\s*reais\b/gi;

export function mentionsUnknownPrice(text: string, allowed: Set<number>): boolean {
  for (const match of text.matchAll(moneyPattern)) {
    const whole = match[1] ?? match[3];
    const fraction = match[2] ?? match[4] ?? "0";
    if (!whole) continue;
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
    if (!Number.isSafeInteger(cents) || !allowed.has(cents)) return true;
  }
  return false;
}
