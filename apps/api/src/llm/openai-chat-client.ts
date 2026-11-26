import {
  chatCompletionsUrl,
  type LlmProvider,
  type LlmSettings
} from "./settings.js";

export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type LlmChatFailureReason = "timeout" | "http" | "network" | "invalid";

export type LlmChatResult =
  | { ok: true; text: string; toolCalls: LlmToolCall[]; toolsDegraded: boolean }
  | { ok: false; reason: LlmChatFailureReason; statusCode?: number };

export interface LlmChatRequest {
  settings: LlmSettings;
  messages: readonly LlmChatMessage[];
  tools?: readonly LlmTool[];
}

export interface LlmChatClient {
  complete(request: LlmChatRequest): Promise<LlmChatResult>;
}

export interface OpenAiCompatibleChatClientOptions {
  fetcher?: typeof fetch;
  sleep?: (attempt: number) => Promise<void>;
  onLog?: (event: LlmClientLogEvent) => void;
}

export interface LlmClientLogEvent {
  level: "info" | "warn";
  event: string;
  provider: LlmProvider;
  model: string;
  attempt: number;
  statusCode?: number;
  toolsDegraded?: boolean;
}

const maxResponseBytes = 32_768;
const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const toolRejectionStatuses = new Set([400, 404, 422, 501]);

type SendResult =
  | { kind: "success"; text: string; toolCalls: LlmToolCall[] }
  | { kind: "tools_unsupported" }
  | { kind: "failure"; reason: LlmChatFailureReason; statusCode?: number; retryable: boolean };

function defaultSleep(attempt: number): Promise<void> {
  const delay = Math.min(1_000, 200 * 2 ** (attempt - 1));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
      return (part as { text: string }).text;
    }
    return "";
  }).join("");
}

function toolCallsFrom(message: unknown): LlmToolCall[] {
  if (!message || typeof message !== "object" || !("tool_calls" in message)) return [];
  const raw = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: LlmToolCall[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const record = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = record.function?.name;
    if (typeof name !== "string" || !name) return;
    let parsed: unknown = {};
    const args = record.function?.arguments;
    if (typeof args === "string" && args.trim()) {
      try {
        parsed = JSON.parse(args) as unknown;
      } catch {
        parsed = {};
      }
    } else if (args && typeof args === "object") parsed = args;
    calls.push({ id: typeof record.id === "string" && record.id ? record.id : `call-${index + 1}`, name, arguments: parsed });
  });
  return calls;
}

async function readLimitedBody(response: Response): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) return undefined;
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
}

function headersFor(settings: LlmSettings): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
  if (settings.provider === "openrouter") {
    headers["HTTP-Referer"] = settings.httpReferer;
    headers["X-Title"] = settings.appTitle;
  }
  return headers;
}

function bodyFor(settings: LlmSettings, messages: readonly LlmChatMessage[], tools: readonly LlmTool[] | undefined): string {
  return JSON.stringify({
    model: settings.model,
    messages,
    temperature: 0,
    stream: false,
    ...(tools && tools.length > 0
      ? {
          tool_choice: "auto",
          tools: tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters }
          }))
        }
      : {})
  });
}

export class OpenAiCompatibleChatClient implements LlmChatClient {
  private readonly fetcher: typeof fetch;
  private readonly sleep: (attempt: number) => Promise<void>;
  private readonly onLog?: (event: LlmClientLogEvent) => void;

  constructor(options: OpenAiCompatibleChatClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    if (options.onLog) this.onLog = options.onLog;
  }

  async complete(request: LlmChatRequest): Promise<LlmChatResult> {
    const requestedTools = request.settings.supportsTools ? request.tools ?? [] : [];
    const first = await this.send(request.settings, request.messages, requestedTools.length > 0 ? requestedTools : undefined);
    if (first.kind === "tools_unsupported") {
      const plain = await this.send(request.settings, request.messages, undefined);
      if (plain.kind === "success") {
        this.log({
          level: "info",
          event: "llm.tools_degraded",
          provider: request.settings.provider,
          model: request.settings.model,
          attempt: 1,
          toolsDegraded: true
        });
        return { ok: true, text: plain.text, toolCalls: [], toolsDegraded: true };
      }
      if (plain.kind === "failure") return this.failure(request.settings, plain);
      return { ok: false, reason: "invalid" };
    }
    if (first.kind === "success") {
      return { ok: true, text: first.text, toolCalls: first.toolCalls, toolsDegraded: false };
    }
    return this.failure(request.settings, first);
  }

  private failure(settings: LlmSettings, result: Extract<SendResult, { kind: "failure" }>): LlmChatResult {
    this.log({
      level: "warn",
      event: "llm.failed",
      provider: settings.provider,
      model: settings.model,
      attempt: settings.maxRetries + 1,
      ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {})
    });
    return result.statusCode !== undefined
      ? { ok: false, reason: result.reason, statusCode: result.statusCode }
      : { ok: false, reason: result.reason };
  }

  private log(event: LlmClientLogEvent): void {
    this.onLog?.(event);
  }

  private async send(
    settings: LlmSettings,
    messages: readonly LlmChatMessage[],
    tools: readonly LlmTool[] | undefined
  ): Promise<SendResult> {
    let last: Extract<SendResult, { kind: "failure" }> = { kind: "failure", reason: "network", retryable: false };
    for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
      if (attempt > 0) await this.sleep(attempt);
      const result = await this.attemptOnce(settings, messages, tools);
      if (result.kind === "success" || result.kind === "tools_unsupported") return result;
      last = result;
      if (!result.retryable || attempt === settings.maxRetries) return result;
    }
    return last;
  }

  private async attemptOnce(
    settings: LlmSettings,
    messages: readonly LlmChatMessage[],
    tools: readonly LlmTool[] | undefined
  ): Promise<SendResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const response = await this.fetcher(chatCompletionsUrl(settings.baseUrl), {
        method: "POST",
        headers: headersFor(settings),
        body: bodyFor(settings, messages, tools),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store"
      });
      const body = await readLimitedBody(response);
      if (body === undefined) return { kind: "failure", reason: "invalid", statusCode: response.status, retryable: false };
      if (!response.ok) {
        if (tools && tools.length > 0 && toolRejectionStatuses.has(response.status)) {
          return { kind: "tools_unsupported" };
        }
        return {
          kind: "failure",
          reason: "http",
          statusCode: response.status,
          retryable: retryableStatuses.has(response.status)
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        return { kind: "failure", reason: "invalid", statusCode: response.status, retryable: false };
      }
      if (!parsed || typeof parsed !== "object" || !("choices" in parsed) || !Array.isArray(parsed.choices)) {
        return { kind: "failure", reason: "invalid", statusCode: response.status, retryable: false };
      }
      const choice = parsed.choices[0] as { message?: unknown } | undefined;
      const message = choice?.message;
      return {
        kind: "success",
        text: messageText(message && typeof message === "object" && "content" in message ? (message as { content?: unknown }).content : ""),
        toolCalls: toolCallsFrom(message)
      };
    } catch (error) {
      if (isAbort(error, controller.signal)) {
        return { kind: "failure", reason: "timeout", retryable: true };
      }
      return { kind: "failure", reason: "network", retryable: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}
