export type Role = "TENANT_ADMIN" | "ATTENDANT";
export type ConversationState =
  | "BOT_ACTIVE"
  | "WAITING_HUMAN"
  | "HUMAN_ACTIVE"
  | "CLOSED";

export interface Membership {
  tenantId: string;
  role: Role;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  platformAdmin: boolean;
  memberships: Membership[];
}

export interface Session {
  user: User;
  csrfToken: string;
  expiresAt: string;
}

export interface Tenant {
  id: string;
  slug: string;
  displayName: string;
  segment: "pizzaria" | "barbearia" | "outro";
  channelPhoneNumberId: string;
}

export interface KnowledgeItem {
  question: string;
  answer: string;
}

export interface BusinessProfile {
  address: string;
  serviceArea: string;
  hours: string;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  deliveryFeeCents: number;
  paymentMethods: string[];
  policies: string;
  persona: string;
}

export interface CatalogChoice {
  id: string;
  name: string;
  priceCents: number;
}

export interface CatalogOptionGroup {
  id: string;
  name: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  choices: CatalogChoice[];
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  category: string;
  available: boolean;
  optionGroups: CatalogOptionGroup[];
}

export interface OrderIntegration {
  webhookUrl?: string;
  webhookSecret?: string | null;
  webhookSecretConfigured?: boolean;
}

export interface LlmConfig {
  provider?: "openrouter" | "local";
  baseUrl?: string;
  model?: string;
  supportsTools?: boolean;
  apiKey?: string | null;
}

export interface TenantConfig {
  businessName: string;
  segment: Tenant["segment"];
  greeting: string;
  knowledge: KnowledgeItem[];
  handoffKeywords: string[];
  assistantMode: "approved_faq" | "local_ai";
  version: number;
  profile: BusinessProfile;
  catalog: CatalogItem[];
  orderingEnabled: boolean;
  orderIntegration?: OrderIntegration;
  llm?: LlmConfig;
}

export type OrderStatus = "draft" | "awaiting_confirmation" | "confirmed" | "sent_to_integration" | "cancelled";

export interface CustomerOrder {
  id: string;
  tenantId: string;
  conversationId: string;
  status: OrderStatus;
  lines: Array<{
    lineId: string;
    itemId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    choices: Array<{ name: string; priceCents: number }>;
    lineTotalCents: number;
  }>;
  fulfillment: { method: "delivery" | "pickup"; address: string; notes: string } | null;
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currency: "BRL";
  integrationReference: string | null;
  integrationError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  tenantId: string;
  customerName: string;
  customerPhone: string;
  state: ConversationState;
  assignedUserId: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string;
  waitingSince: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "CUSTOMER" | "BOT" | "ATTENDANT";
  text: string;
  createdAt: string;
  deliveryStatus: "RECEIVED" | "SIMULATED" | "PENDING" | "SENDING" | "ACCEPTED" | "BLOCKED" | "HTTP_ERROR" | "INDETERMINATE";
  authorName: string | null;
}

export interface ConfigResponse {
  tenant: Tenant;
  config: TenantConfig;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  allowNotReady?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.csrfToken) headers.set("x-csrf-token", options.csrfToken);

  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok && !(options.allowNotReady && response.status === 503)) {
    let message = "Não foi possível concluir esta ação.";
    let code: string | undefined;
    try {
      const payload = (await response.json()) as { message?: unknown; error?: unknown; code?: unknown };
      if (typeof payload.message === "string") message = payload.message;
      if (typeof payload.code === "string") code = payload.code;
      else if (typeof payload.error === "string") code = payload.error;
      if (!payload.message && code === "invalid_payload") message = "Confira os campos preenchidos e tente novamente.";
    } catch {
      // Algumas respostas, como 204 e erros de proxy, não incluem JSON.
    }
    throw new ApiError(response.status, message, code);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function tenantPath(tenantId: string, resource = ""): string {
  const suffix = resource ? `/${resource.replace(/^\//, "")}` : "";
  return `/api/v1/tenants/${encodeURIComponent(tenantId)}${suffix}`;
}

export function formatApiError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Não foi possível conectar ao serviço local.";
  return "Ocorreu um erro inesperado.";
}
