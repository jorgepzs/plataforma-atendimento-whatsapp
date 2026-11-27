import { stripInvisibleAndControlChars } from "./input-guard.js";
import type { GuardrailViolation, ToolGuardInput, ToolGuardResult } from "./types.js";

const DEFAULT_MAX_CALLS_PER_TURN = 8;
const DEFAULT_MAX_ARG_CHARS = 4_000;

const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "price",
  "priceCents",
  "unitPrice",
  "unitPriceCents",
  "total",
  "totalCents",
  "subtotal",
  "subtotalCents",
  "discount",
  "discountCents",
  "discountPercent",
  "deliveryFee",
  "deliveryFeeCents",
  "overridePrice",
  "customPrice"
]);

const ALLOWED_KEYS_BY_TOOL: Record<string, ReadonlySet<string>> = {
  get_catalog: new Set([]),
  search_catalog: new Set(["query"]),
  add_item: new Set(["itemId", "id", "quantity", "choiceIds", "optionIds"]),
  update_item: new Set(["lineId", "quantity", "choiceIds", "optionIds"]),
  remove_item: new Set(["lineId"]),
  set_fulfillment: new Set(["method", "address", "notes"]),
  get_order_summary: new Set([]),
  confirm_order: new Set([]),
  transfer_to_human: new Set(["reason"])
};

function fail(code: string, message: string, violations: GuardrailViolation[] = []): ToolGuardResult {
  const entry: GuardrailViolation = {
    code,
    category: "tool_policy",
    severity: "high",
    message
  };
  return {
    ok: false,
    error: code,
    message,
    violations: [...violations, entry]
  };
}

function cleanString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = stripInvisibleAndControlChars(value).cleaned;
  if (cleaned.length > maxLen) return undefined;
  return cleaned;
}

function cleanStringArray(value: unknown, maxItems: number, maxItemLen: number): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const cleaned = stripInvisibleAndControlChars(item).cleaned;
    if (!cleaned || cleaned.length > maxItemLen) return undefined;
    result.push(cleaned);
  }
  return result;
}

export function validateToolCall(input: ToolGuardInput): ToolGuardResult {
  const maxCalls = input.maxCallsPerTurn ?? DEFAULT_MAX_CALLS_PER_TURN;
  const maxArgChars = input.maxArgChars ?? DEFAULT_MAX_ARG_CHARS;

  if (input.callCountInTurn >= maxCalls) {
    return fail("tool_call_limit_exceeded", `Limite de ${maxCalls} chamadas de ferramentas por turno excedido.`);
  }

  if (!input.allowedTools.includes(input.toolName)) {
    return fail("tool_not_allowed", `Ferramenta '${input.toolName}' não está autorizada neste contexto.`);
  }

  let parsedArgs: unknown = input.args;
  if (parsedArgs === undefined || parsedArgs === null || parsedArgs === "") {
    parsedArgs = {};
  }
  if (typeof parsedArgs === "string") {
    if (parsedArgs.length > maxArgChars) {
      return fail("tool_args_too_large", "Argumentos da ferramenta excedem o tamanho permitido.");
    }
    try {
      parsedArgs = JSON.parse(parsedArgs);
    } catch {
      return fail("invalid_tool_args_json", "Argumentos JSON inválidos para a ferramenta.");
    }
  }

  if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
    return fail("invalid_tool_args", "Os argumentos da ferramenta devem ser um objeto JSON.");
  }

  const rawRecord = parsedArgs as Record<string, unknown>;
  const serializedSize = JSON.stringify(rawRecord).length;
  if (serializedSize > maxArgChars) {
    return fail("tool_args_too_large", "Argumentos da ferramenta excedem o tamanho permitido.");
  }

  const allowedKeys = ALLOWED_KEYS_BY_TOOL[input.toolName];
  if (!allowedKeys) {
    return fail("unknown_tool", "Ferramenta desconhecida.");
  }

  for (const key of Object.keys(rawRecord)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return fail("forbidden_tool_argument", `Parâmetro proibido '${key}' na chamada da ferramenta.`);
    }
    if (!allowedKeys.has(key)) {
      return fail("unexpected_tool_argument", `Parâmetro não suportado '${key}' para '${input.toolName}'.`);
    }
  }

  switch (input.toolName) {
    case "get_catalog":
    case "get_order_summary":
    case "confirm_order":
      return { ok: true, sanitizedArgs: {}, violations: [] };

    case "search_catalog": {
      const query = cleanString(rawRecord.query ?? "", 120);
      if (query === undefined) return fail("invalid_query", "Parâmetro query inválido.");
      return { ok: true, sanitizedArgs: { query }, violations: [] };
    }

    case "add_item": {
      const itemId = cleanString(rawRecord.itemId ?? rawRecord.id, 80);
      if (!itemId) return fail("invalid_item_id", "Parâmetro itemId obrigatório e inválido.");
      const quantity = rawRecord.quantity === undefined ? 1 : Number(rawRecord.quantity);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 50) {
        return fail("invalid_quantity", "Quantidade deve ser um inteiro entre 1 e 50.");
      }
      const choiceIds = cleanStringArray(rawRecord.choiceIds ?? rawRecord.optionIds, 20, 80);
      if (!choiceIds) return fail("invalid_choice_ids", "Lista de opções (choiceIds) inválida.");
      return { ok: true, sanitizedArgs: { itemId, quantity, choiceIds }, violations: [] };
    }

    case "update_item": {
      const lineId = cleanString(rawRecord.lineId, 120);
      if (!lineId) return fail("invalid_line_id", "Parâmetro lineId obrigatório e inválido.");
      const sanitized: Record<string, unknown> = { lineId };
      if (rawRecord.quantity !== undefined) {
        const quantity = Number(rawRecord.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 50) {
          return fail("invalid_quantity", "Quantidade deve ser um inteiro entre 1 e 50.");
        }
        sanitized.quantity = quantity;
      }
      if (rawRecord.choiceIds !== undefined || rawRecord.optionIds !== undefined) {
        const choiceIds = cleanStringArray(rawRecord.choiceIds ?? rawRecord.optionIds, 20, 80);
        if (!choiceIds) return fail("invalid_choice_ids", "Lista de opções (choiceIds) inválida.");
        sanitized.choiceIds = choiceIds;
      }
      return { ok: true, sanitizedArgs: sanitized, violations: [] };
    }

    case "remove_item": {
      const lineId = cleanString(rawRecord.lineId, 120);
      if (!lineId) return fail("invalid_line_id", "Parâmetro lineId obrigatório e inválido.");
      return { ok: true, sanitizedArgs: { lineId }, violations: [] };
    }

    case "set_fulfillment": {
      const method = cleanString(rawRecord.method, 20);
      if (method !== "delivery" && method !== "pickup") {
        return fail("invalid_fulfillment", "Forma de entrega deve ser 'delivery' ou 'pickup'.");
      }
      const address = rawRecord.address === undefined ? "" : cleanString(rawRecord.address, 240);
      if (address === undefined) return fail("invalid_address", "Endereço inválido ou longo demais.");
      const notes = rawRecord.notes === undefined ? undefined : cleanString(rawRecord.notes, 300);
      if (rawRecord.notes !== undefined && notes === undefined) {
        return fail("invalid_notes", "Observações inválidas ou longas demais.");
      }
      return {
        ok: true,
        sanitizedArgs: { method, address, ...(notes !== undefined ? { notes } : {}) },
        violations: []
      };
    }

    case "transfer_to_human": {
      const reason = rawRecord.reason === undefined ? "" : cleanString(rawRecord.reason, 240);
      if (reason === undefined) return fail("invalid_reason", "Motivo da transferência inválido.");
      return { ok: true, sanitizedArgs: { reason }, violations: [] };
    }

    default:
      return fail("unknown_tool", "Ferramenta desconhecida.");
  }
}
