import type { KnowledgeEntry, TenantSegment } from "../attendance/types.js";
import {
  allowedAmounts,
  buildJsonPrompt,
  buildSystemPrompt,
  inferPlanFromText,
  isOrderIntent,
  textMentionsItem,
  mentionsUnknownPrice,
  orderingTools,
  parseFallbackPlan,
  transferTool,
  type BusinessProfile,
  type CatalogItem,
  type CustomerOrder,
  type OrderSession
} from "../ordering/index.js";
import { emptyProfile } from "../ordering/catalog.js";
import type { LlmChatClient, LlmChatMessage } from "./openai-chat-client.js";
import {
  resolveLlmSettings,
  type LlmSettings,
  type TenantLlmOverride
} from "./settings.js";

export type LlmTurnOutcome =
  | { kind: "reply"; text: string }
  | { kind: "handoff"; text?: string }
  | { kind: "reply_and_handoff"; text: string };

export interface LlmTurnInput {
  businessName: string;
  segment: TenantSegment;
  assistantObjective?: string;
  customerText: string;
  history?: readonly { role: "user" | "assistant"; content: string }[];
  knowledge: readonly KnowledgeEntry[];
  profile?: BusinessProfile;
  catalog?: readonly CatalogItem[];
  orderingEnabled?: boolean;
  order?: CustomerOrder | null;
  historicalOrderRequested?: boolean;
  historicalOrderMode?: "read_only" | "repeat";
  historicalOrder?: CustomerOrder | null;
  session?: OrderSession;
  override?: TenantLlmOverride;
}

export interface LlmAssistant {
  completeTurn(input: LlmTurnInput): Promise<LlmTurnOutcome>;
  failureOutcome(): LlmTurnOutcome;
}

const transferToolName = "transfer_to_human";
const handoffNotice = "Vou encaminhar você para uma pessoa.";
const maxCustomerTextLength = 4_000;
const maxReplyLength = 1_500;
const maxToolRounds = 4;
const maxHistoryCharacters = 8_000;
const maxRequestCharacters = 32_000;

function boundedHistory(
  history: readonly { role: "user" | "assistant"; content: string }[] | undefined,
  maxCharacters: number
): Array<{ role: "user" | "assistant"; content: string }> {
  const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
  let remaining = Math.max(0, maxCharacters);
  for (const message of [...(history ?? [])].slice(-8).reverse()) {
    if (remaining <= 0) break;
    const content = message.content.trim();
    if (!content) continue;
    const bounded = content.length > remaining ? content.slice(0, remaining) : content;
    selected.push({ role: message.role, content: bounded });
    remaining -= bounded.length;
  }
  return selected.reverse();
}

function sanitizeReply(text: string, secret?: string): string {
  const withoutSecret = secret ? text.split(secret).join("") : text;
  const cleaned = withoutSecret
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > maxReplyLength ? cleaned.slice(0, maxReplyLength).trim() : cleaned;
}

function failureFrom(settings: LlmSettings): LlmTurnOutcome {
  if (settings.failureAction === "handoff") return { kind: "handoff" };
  if (settings.failureAction === "reply") return { kind: "reply", text: settings.failureMessage };
  return { kind: "reply_and_handoff", text: settings.failureMessage };
}

function guardedText(text: string, input: LlmTurnInput, secret?: string): string {
  const cleaned = sanitizeReply(text, secret);
  if (!cleaned) return "";
  const profile = input.profile ?? emptyProfile();
  const catalog = input.catalog ?? [];
  if (mentionsUnknownPrice(cleaned, allowedAmounts(catalog, profile, input.session?.order() ?? input.order ?? null))) {
    return "";
  }
  return cleaned;
}

export function createLlmAssistant(client: LlmChatClient, baseSettings: LlmSettings): LlmAssistant {
  return {
    failureOutcome: () => failureFrom(baseSettings),
    async completeTurn(input) {
      const customerText = input.customerText.trim();
      if (!customerText || customerText.length > maxCustomerTextLength) return failureFrom(baseSettings);
      const profile = input.profile ?? emptyProfile();
      const catalog = input.catalog ?? [];
      const orderingEnabled = input.orderingEnabled === true && catalog.some((item) => item.available);
      const prompt = buildSystemPrompt({
        businessName: input.businessName,
        segment: input.segment,
        ...(input.assistantObjective !== undefined ? { assistantObjective: input.assistantObjective } : {}),
        knowledge: input.knowledge,
        profile,
        catalog,
        orderingEnabled,
        order: input.order ?? null,
        ...(input.historicalOrderRequested !== undefined ? { historicalOrderRequested: input.historicalOrderRequested } : {}),
        ...(input.historicalOrderMode !== undefined ? { historicalOrderMode: input.historicalOrderMode } : {}),
        ...(input.historicalOrder ? { historicalOrder: input.historicalOrder } : {})
      });
      if (!prompt) return failureFrom(baseSettings);

      try {
        const settings = resolveLlmSettings(baseSettings, input.override);
        const tools = orderingEnabled && input.session ? orderingTools : [transferTool];
        const historyBudget = Math.min(maxHistoryCharacters, maxRequestCharacters - prompt.length - customerText.length);
        const history = boundedHistory(input.history, historyBudget);
        const messages: LlmChatMessage[] = [
          { role: "system", content: prompt },
          ...history,
          { role: "user", content: customerText }
        ];
        if (!settings.supportsTools) {
          const plain = await client.complete({ settings, messages });
          if (!plain.ok) return failureFrom(baseSettings);
          return withoutTools(client, settings, input, plain.text);
        }

        for (let round = 0; round < maxToolRounds; round += 1) {
          const result = await client.complete({ settings, tools, messages });
          if (!result.ok) return failureFrom(baseSettings);
          if (result.toolsDegraded) return withoutTools(client, settings, input, result.text);
          if (result.toolCalls.some((call) => call.name === transferToolName)) {
            return { kind: "handoff", text: handoffNotice };
          }
          if (result.toolCalls.length === 0 || !input.session) {
            const text = guardedText(result.text, input, settings.apiKey);
            if (!text) return orderingFallback(input) ?? failureFrom(baseSettings);
            return { kind: "reply", text };
          }
          messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
          for (const call of result.toolCalls) {
            const output = await input.session.execute(call.name, call.arguments);
            messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(output) });
            if (output.handoff) return { kind: "handoff", text: handoffNotice };
          }
        }
        const summary = input.session?.order();
        if (summary && summary.lines.length > 0) {
          const text = guardedText(summaryText(input), input, settings.apiKey);
          if (text) return { kind: "reply", text };
        }
        return failureFrom(baseSettings);
      } catch {
        return failureFrom(baseSettings);
      }
    }
  };
}

function summaryText(input: LlmTurnInput): string {
  const order = input.session?.order();
  if (!order || order.lines.length === 0) return "";
  return order.lines.map((line) => `${line.quantity}× ${line.name}`).join(", ");
}

function orderingMessage(input: LlmTurnInput): boolean {
  return isOrderIntent(input.customerText) || Boolean(input.order) || textMentionsItem(input.customerText, input.catalog ?? []);
}

function orderingFallback(input: LlmTurnInput): LlmTurnOutcome | undefined {
  if (!input.session || !input.orderingEnabled) return undefined;
  if (!orderingMessage(input)) return undefined;
  return { kind: "reply", text: "Me diz o item e o tamanho que eu monto com o preço do cardápio." };
}

async function withoutTools(
  client: LlmChatClient,
  settings: LlmSettings,
  input: LlmTurnInput,
  degradedText = ""
): Promise<LlmTurnOutcome> {
  const catalog = input.catalog ?? [];
  const ordering = input.orderingEnabled === true && Boolean(input.session) && catalog.some((item) => item.available);
  const orderish = ordering && orderingMessage(input);
  let plan = parseFallbackPlan(degradedText);
  let plain = degradedText;
  if (!plan && orderish && input.session) {
    const jsonPrompt = buildJsonPrompt({ businessName: input.businessName, catalog });
    const historyBudget = Math.min(maxHistoryCharacters, maxRequestCharacters - jsonPrompt.length - input.customerText.length);
    const second = await client.complete({
      settings,
      messages: [
        { role: "system", content: jsonPrompt },
        ...boundedHistory(input.history, historyBudget),
        { role: "user", content: input.customerText }
      ]
    });
    if (second.ok) {
      plain = second.text || plain;
      plan = parseFallbackPlan(second.text);
    }
  }
  if (ordering && input.session && (plan || orderish)) {
    const applied = await input.session.applyPlan(plan ?? inferPlanFromText(input.customerText, catalog, input.profile ?? emptyProfile()));
    if (applied.handoff) return { kind: "handoff", text: handoffNotice };
    const serverText = guardedText(applied.message, input, settings.apiKey);
    if (applied.changed && serverText) return { kind: "reply", text: serverText };
    if (serverText && !plan?.reply) return { kind: "reply", text: serverText };
  }
  const safe = guardedText(plain, input, settings.apiKey);
  if (safe) return { kind: "reply", text: safe };
  return orderingFallback(input) ?? failureFrom(settings);
}
