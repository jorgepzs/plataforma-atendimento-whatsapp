export type LlmProvider = "openrouter" | "local";
export type LlmFailureAction = "reply" | "handoff" | "reply_and_handoff";

export interface LlmSettings {
  provider: LlmProvider;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  httpReferer: string;
  appTitle: string;
  failureMessage: string;
  failureAction: LlmFailureAction;
  supportsTools: boolean;
  apiKey?: string;
}

/** Campos opcionais gravados na configuração da empresa. A chave nunca volta na API. */
export interface TenantLlmOverride {
  provider?: LlmProvider;
  baseUrl?: string;
  model?: string;
  supportsTools?: boolean;
  apiKey?: string;
}

export interface TenantLlmUpdate {
  provider?: LlmProvider | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  supportsTools?: boolean | undefined;
  /** `null` remove a chave gravada. Ausente preserva a chave atual. */
  apiKey?: string | null | undefined;
}

export interface LlmEnvironmentInput {
  provider?: LlmProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  maxRetries: number;
  httpReferer?: string;
  appTitle?: string;
  failureMessage?: string;
  failureAction: LlmFailureAction;
  supportsTools: boolean;
}

export class LlmSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmSettingsError";
  }
}

const modelNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const providers = new Set<LlmProvider>(["openrouter", "local"]);
const failureActions = new Set<LlmFailureAction>(["reply", "handoff", "reply_and_handoff"]);

export function defaultLlmBaseUrl(provider: LlmProvider): string {
  return provider === "openrouter" ? "https://openrouter.ai/api/v1" : "http://127.0.0.1:11434/v1";
}

export function assertHttpBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LlmSettingsError("URL do provedor de IA inválida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LlmSettingsError("URL do provedor de IA deve usar HTTP ou HTTPS.");
  }
  if (url.username || url.password) {
    throw new LlmSettingsError("URL do provedor de IA não pode conter credenciais.");
  }
  if (url.search || url.hash) {
    throw new LlmSettingsError("URL do provedor de IA não pode conter consulta ou fragmento.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function chatCompletionsUrl(baseUrl: string): string {
  const url = new URL(assertHttpBaseUrl(baseUrl));
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  return url.toString();
}

function assertModel(model: string): string {
  if (!modelNamePattern.test(model)) throw new LlmSettingsError("Modelo de IA inválido.");
  return model;
}

function assertApiKey(apiKey: string): string {
  if (apiKey.length < 1 || apiKey.length > 512 || /\s/.test(apiKey)) {
    throw new LlmSettingsError("Chave de IA inválida.");
  }
  return apiKey;
}

function assertFailureMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(trimmed)) {
    throw new LlmSettingsError("LLM_FAILURE_MESSAGE é inválida.");
  }
  return trimmed;
}

function assertAppTitle(title: string): string {
  const trimmed = title.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed || trimmed.length > 80) throw new LlmSettingsError("LLM_APP_TITLE é inválido.");
  return trimmed;
}

export function llmSettingsFromEnvironment(input: LlmEnvironmentInput): LlmSettings | undefined {
  if (!input.provider) return undefined;
  if (!input.model) throw new LlmSettingsError("LLM_MODEL é obrigatório quando LLM_PROVIDER está configurado.");
  if (input.provider === "openrouter" && !input.apiKey) {
    throw new LlmSettingsError("LLM_API_KEY é obrigatória quando LLM_PROVIDER=openrouter.");
  }

  const settings: LlmSettings = {
    provider: input.provider,
    baseUrl: assertHttpBaseUrl(input.baseUrl ?? defaultLlmBaseUrl(input.provider)),
    model: assertModel(input.model),
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries,
    httpReferer: assertHttpBaseUrl(input.httpReferer ?? "http://localhost"),
    appTitle: assertAppTitle(input.appTitle ?? "Plataforma de atendimento"),
    failureMessage: assertFailureMessage(
      input.failureMessage ?? "Não consegui responder agora. Vou transferir você para uma pessoa."
    ),
    failureAction: input.failureAction,
    supportsTools: input.supportsTools
  };
  if (input.apiKey) settings.apiKey = assertApiKey(input.apiKey);
  return settings;
}

export function isPrivateLlmHost(baseUrl: string): boolean {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host) || host.endsWith(".local")) return true;
  const parts = host.split(".").map((item) => Number(item));
  const a = parts[0];
  const b = parts[1];
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return false;
  if (a === undefined || b === undefined) return false;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function readOverride(value: TenantLlmOverride | TenantLlmUpdate): {
  provider?: LlmProvider;
  baseUrl?: string;
  model?: string;
  supportsTools?: boolean;
  apiKey?: string;
} {
  if (!value || typeof value !== "object") throw new LlmSettingsError("Configuração de IA da empresa inválida.");
  const record = value as Record<string, unknown>;
  const known = new Set(["provider", "baseUrl", "model", "supportsTools", "apiKey"]);
  if (Object.keys(record).some((key) => !known.has(key))) {
    throw new LlmSettingsError("Configuração de IA da empresa inválida.");
  }

  const provider = record.provider;
  if (provider !== undefined && (typeof provider !== "string" || !providers.has(provider as LlmProvider))) {
    throw new LlmSettingsError("Provedor de IA da empresa inválido.");
  }
  const baseUrl = record.baseUrl;
  if (baseUrl !== undefined && typeof baseUrl !== "string") throw new LlmSettingsError("URL do provedor de IA inválida.");
  const model = record.model;
  if (model !== undefined && typeof model !== "string") throw new LlmSettingsError("Modelo de IA inválido.");
  const supportsTools = record.supportsTools;
  if (supportsTools !== undefined && typeof supportsTools !== "boolean") {
    throw new LlmSettingsError("Configuração de ferramentas de IA inválida.");
  }
  const apiKey = record.apiKey;
  if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") {
    throw new LlmSettingsError("Chave de IA inválida.");
  }

  return {
    ...(typeof provider === "string" ? { provider: provider as LlmProvider } : {}),
    ...(typeof baseUrl === "string" ? { baseUrl: assertHttpBaseUrl(baseUrl) } : {}),
    ...(typeof model === "string" ? { model: assertModel(model) } : {}),
    ...(typeof supportsTools === "boolean" ? { supportsTools } : {}),
    ...(typeof apiKey === "string" ? { apiKey: assertApiKey(apiKey) } : {})
  };
}

export function copyTenantLlmOverride(value: TenantLlmOverride | undefined): TenantLlmOverride | undefined {
  if (!value) return undefined;
  try {
    const read = readOverride(value);
    return Object.keys(read).length > 0 ? read : undefined;
  } catch {
    return undefined;
  }
}

export function mergeTenantLlmUpdate(
  previous: TenantLlmOverride | undefined,
  update: TenantLlmUpdate | null | undefined
): TenantLlmOverride | undefined {
  if (update === undefined) return copyTenantLlmOverride(previous);
  if (update === null) return undefined;

  const incoming = readOverride(update);
  const prior = copyTenantLlmOverride(previous);
  const providerChanged = incoming.provider !== undefined && incoming.provider !== prior?.provider;
  const clearKey = update.apiKey === null || (providerChanged && update.apiKey === undefined);
  const apiKey = clearKey ? undefined : incoming.apiKey ?? prior?.apiKey;
  const baseUrl = incoming.baseUrl ?? (providerChanged ? undefined : prior?.baseUrl);
  const model = incoming.model ?? (providerChanged ? undefined : prior?.model);
  const supportsTools = incoming.supportsTools ?? (providerChanged ? undefined : prior?.supportsTools);
  const provider = incoming.provider ?? prior?.provider;

  const merged: TenantLlmOverride = {
    ...(provider ? { provider } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(supportsTools !== undefined ? { supportsTools } : {}),
    ...(apiKey ? { apiKey } : {})
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveLlmSettings(base: LlmSettings, override?: TenantLlmOverride): LlmSettings {
  const stored = copyTenantLlmOverride(override);
  if (!stored) return base;

  const provider = stored.provider ?? base.provider;
  const providerChanged = provider !== base.provider;
  const apiKey = stored.apiKey ?? (providerChanged ? undefined : base.apiKey);
  const resolved: LlmSettings = {
    provider,
    baseUrl: stored.baseUrl ?? (providerChanged ? defaultLlmBaseUrl(provider) : base.baseUrl),
    model: stored.model ?? base.model,
    timeoutMs: base.timeoutMs,
    maxRetries: base.maxRetries,
    httpReferer: base.httpReferer,
    appTitle: base.appTitle,
    failureMessage: base.failureMessage,
    failureAction: base.failureAction,
    supportsTools: stored.supportsTools ?? base.supportsTools
  };
  if (apiKey) resolved.apiKey = apiKey;
  if (!failureActions.has(resolved.failureAction)) throw new LlmSettingsError("Política de falha da IA inválida.");
  return resolved;
}

export function presentTenantLlmOverride(value: TenantLlmOverride | undefined): TenantLlmOverride | undefined {
  const copy = copyTenantLlmOverride(value);
  if (!copy?.apiKey) return copy;
  const { apiKey: _apiKey, ...rest } = copy;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
