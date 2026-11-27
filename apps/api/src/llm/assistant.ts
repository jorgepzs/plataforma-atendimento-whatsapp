import type { KnowledgeEntry, TenantSegment } from "../attendance/types.js";
import { guardAssistantOutput, inspectCustomerInput, validateToolCall } from "../guardrails/index.js";
import type { RagRetrievedContext } from "../rag/types.js";
import {
  buildJsonPrompt,
  buildSystemPrompt,
  inferPlanFromText,
  isOrderIntent,
  textMentionsItem,
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
  rag?: RagRetrievedContext;
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

function guardedText(
  text: string,
  input: LlmTurnInput,
  secret?: string,
  confirmedInThisTurn = false
): string {
  const result = guardAssistantOutput(text, {
    catalog: input.catalog ?? [],
    profile: input.profile ?? emptyProfile(),
    order: input.session?.order() ?? input.order ?? null,
    confirmedInThisTurn,
    secrets: secret ? [secret] : [],
    maxLength: maxReplyLength
  });
  return result.ok ? result.sanitizedText : "";
}

export function createLlmAssistant(client: LlmChatClient, baseSettings: LlmSettings): LlmAssistant {
  return {
    failureOutcome: () => failureFrom(baseSettings),
    async completeTurn(input) {
      const inputCheck = inspectCustomerInput(input.customerText);
      if (!inputCheck.allowed) {
        return { kind: "handoff", text: handoffNotice };
      }
      const customerText = inputCheck.sanitizedText;
      if (!customerText || customerText.length > maxCustomerTextLength) return failureFrom(baseSettings);
      const safeInput: LlmTurnInput = customerText === input.customerText
        ? input
        : { ...input, customerText };
      const profile = safeInput.profile ?? emptyProfile();
      const catalog = safeInput.catalog ?? [];
      const orderingEnabled = safeInput.orderingEnabled === true && catalog.some((item) => item.available);
      const prompt = buildSystemPrompt({
        businessName: safeInput.businessName,
        segment: safeInput.segment,
        ...(safeInput.assistantObjective !== undefined ? { assistantObjective: safeInput.assistantObjective } : {}),
        knowledge: safeInput.knowledge,
        profile,
        catalog,
        orderingEnabled,
        order: safeInput.order ?? null,
        ...(safeInput.historicalOrderRequested !== undefined ? { historicalOrderRequested: safeInput.historicalOrderRequested } : {}),
        ...(safeInput.historicalOrderMode !== undefined ? { historicalOrderMode: safeInput.historicalOrderMode } : {}),
        ...(safeInput.historicalOrder ? { historicalOrder: safeInput.historicalOrder } : {}),
        ...(safeInput.rag ? { rag: safeInput.rag } : {})
      });
      if (!prompt) return failureFrom(baseSettings);

      try {
        const settings = resolveLlmSettings(baseSettings, safeInput.override);
        const tools = orderingEnabled && safeInput.session ? orderingTools : [transferTool];
        const allowedToolNames = tools.map((tool) => tool.name);
        const historyBudget = Math.min(maxHistoryCharacters, maxRequestCharacters - prompt.length - customerText.length);
        const history = boundedHistory(safeInput.history, historyBudget);
        const messages: LlmChatMessage[] = [
          { role: "system", content: prompt },
          ...history,
          { role: "user", content: customerText }
        ];
        if (!settings.supportsTools) {
          const plain = await client.complete({ settings, messages });
          if (!plain.ok) return failureFrom(baseSettings);
          return withoutTools(client, settings, safeInput, plain.text);
        }

        let toolCallCount = 0;
        let confirmedInThisTurn = false;
        for (let round = 0; round < maxToolRounds; round += 1) {
          const result = await client.complete({ settings, tools, messages });
          if (!result.ok) return failureFrom(baseSettings);
          if (result.toolsDegraded) return withoutTools(client, settings, safeInput, result.text);
          if (result.toolCalls.some((call) => call.name === transferToolName)) {
            return { kind: "handoff", text: handoffNotice };
          }
          if (result.toolCalls.length === 0 || !safeInput.session) {
            const text = guardedText(result.text, safeInput, settings.apiKey, confirmedInThisTurn);
            if (!text) return orderingFallback(safeInput) ?? failureFrom(baseSettings);
            return { kind: "reply", text };
          }
          messages.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
          for (const call of result.toolCalls) {
            const checked = validateToolCall({
              toolName: call.name,
              args: call.arguments,
              allowedTools: allowedToolNames,
              callCountInTurn: toolCallCount
            });
            toolCallCount += 1;
            if (!checked.ok) {
              messages.push({
                role: "tool",
                toolCallId: call.id,
                content: JSON.stringify({ ok: false, error: checked.error, message: checked.message, changed: false, handoff: false })
              });
              continue;
            }
            const output = await safeInput.session.execute(call.name, checked.sanitizedArgs ?? {});
            if (call.name === "confirm_order" && output.ok) confirmedInThisTurn = true;
            messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(output) });
            if (output.handoff) return { kind: "handoff", text: handoffNotice };
          }
        }
        const summary = safeInput.session?.order();
        if (summary && summary.lines.length > 0) {
          const text = guardedText(summaryText(safeInput), safeInput, settings.apiKey, confirmedInThisTurn);
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
