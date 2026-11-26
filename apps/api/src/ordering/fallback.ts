import type { FallbackPlan } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseFallbackPlan(text: string): FallbackPlan | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record) return undefined;
  const items = Array.isArray(record.items) ? record.items.flatMap((item) => {
    const entry = asRecord(item);
    if (!entry) return [];
    const choiceIds = Array.isArray(entry.choiceIds)
      ? entry.choiceIds.filter((choice): choice is string => typeof choice === "string")
      : [];
    const choices = Array.isArray(entry.choices)
      ? entry.choices.filter((choice): choice is string => typeof choice === "string")
      : [];
    return [{
      ...(typeof entry.itemId === "string" ? { itemId: entry.itemId } : {}),
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      ...(Number.isSafeInteger(entry.quantity) ? { quantity: Number(entry.quantity) } : {}),
      ...(choiceIds.length > 0 ? { choiceIds } : {}),
      ...(choices.length > 0 ? { choices } : {})
    }];
  }) : [];
  const fulfillment = asRecord(record.fulfillment);
  const method = fulfillment?.method === "delivery" || fulfillment?.method === "pickup" ? fulfillment.method : undefined;
  return {
    ...(record.handoff === true ? { handoff: true } : {}),
    ...(record.confirm === true ? { confirm: true } : {}),
    ...(typeof record.reply === "string" ? { reply: record.reply } : {}),
    ...(items.length > 0 ? { items } : {}),
    ...(fulfillment ? {
      fulfillment: {
        ...(method ? { method } : {}),
        ...(typeof fulfillment.address === "string" ? { address: fulfillment.address } : {}),
        ...(typeof fulfillment.notes === "string" ? { notes: fulfillment.notes } : {})
      }
    } : {})
  };
}
