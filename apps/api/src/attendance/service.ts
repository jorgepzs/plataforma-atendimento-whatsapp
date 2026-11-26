import { randomUUID } from "node:crypto";
import {
  assertConversationTransition,
  type ConversationState
} from "../domain/conversation-state.js";
import type { InboundMessageType, NormalizedInboundMessage } from "../meta/inbound-message.js";
import type {
  Conversation,
  CreateTenantInput,
  CustomerMessageNotice,
  AttendanceSnapshot,
  AttendanceStateRepository,
  KnowledgeEntry,
  LocalOutboundOptions,
  Message,
  OutboxEntry,
  OutboundBlockReason,
  OutboundMessageNotice,
  OutboundStatus,
  PendingInboundEventStore,
  SimulateMessageInput,
  SimulateMessageResult,
  Tenant,
  TenantConfig,
  TenantSegment,
  UpdateTenantConfigInput
} from "./types.js";
import type { KnowledgeAnswerSelector } from "./knowledge-classifier.js";
import type { LlmAssistant, LlmTurnOutcome } from "../llm/assistant.js";
import { LlmSettingsError, mergeTenantLlmUpdate, presentTenantLlmOverride, copyTenantLlmOverride } from "../llm/settings.js";
import {
  assertCatalog,
  barbeariaProfile,
  copyCatalog,
  copyProfile,
  createWebhookOrderSink,
  emptyProfile,
  isOrderIntent,
  isSchedulingOrQuote,
  textMentionsItem,
  OrderSession,
  pizzariaCatalog,
  pizzariaProfile,
  type CustomerOrder,
  type OrderSink
} from "../ordering/index.js";
import { CatalogError } from "../ordering/catalog.js";

export class AttendanceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AttendanceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface TenantRecord {
  tenant: Tenant;
  config: TenantConfig;
}

interface ServiceOptions {
  now?: () => Date;
  createId?: () => string;
  workerIntervalMs?: number;
  repository?: AttendanceStateRepository;
  knowledgeAnswerSelector?: KnowledgeAnswerSelector;
  llmAssistant?: LlmAssistant;
  orderSink?: OrderSink;
  outbound?: LocalOutboundOptions;
  onCustomerMessage?: (event: CustomerMessageNotice) => void;
  onOutboundMessage?: (event: OutboundMessageNotice) => void;
}

const outboundServiceWindowMs = 24 * 60 * 60 * 1_000;

const defaultKnowledge: Record<"pizzaria" | "barbearia", KnowledgeEntry[]> = {
  pizzaria: [
    {
      question: "Qual é o horário de funcionamento?",
      answer: "Funcionamos todos os dias, das 18h às 23h."
    },
    {
      question: "Qual é o endereço?",
      answer: "Estamos na Rua das Flores, 123."
    },
    {
      question: "Quais formas de pagamento vocês aceitam?",
      answer: "Aceitamos dinheiro, cartão e Pix."
    }
  ],
  barbearia: [
    {
      question: "Qual é o horário de funcionamento?",
      answer: "Funcionamos de terça a sábado, das 9h às 19h."
    },
    {
      question: "Qual é o endereço?",
      answer: "Estamos na Avenida Central, 456."
    },
    {
      question: "Quais formas de pagamento vocês aceitam?",
      answer: "Aceitamos dinheiro, cartão e Pix."
    }
  ]
};

const defaultHandoffKeywords = [
  "humano",
  "atendente",
  "pessoa",
  "falar com alguém",
  "falar com alguem",
  "falar com atendente"
];

const demoTenants: Array<{
  tenant: Tenant;
  greeting: string;
  knowledge: KnowledgeEntry[];
}> = [
  {
    tenant: {
      id: "pizzaria-demo",
      slug: "pizzaria-demo",
      displayName: "Pizzaria Demo",
      segment: "pizzaria",
      channelPhoneNumberId: "demo-pizzaria-phone"
    },
    greeting: "Olá! Sou o assistente virtual da Pizzaria Demo. Como posso ajudar?",
    knowledge: defaultKnowledge.pizzaria
  },
  {
    tenant: {
      id: "barbearia-demo",
      slug: "barbearia-demo",
      displayName: "Barbearia Demo",
      segment: "barbearia",
      channelPhoneNumberId: "demo-barbearia-phone"
    },
    greeting: "Olá! Sou o assistente virtual da Barbearia Demo. Como posso ajudar?",
    knowledge: defaultKnowledge.barbearia
  }
];

function copyTenant(tenant: Tenant): Tenant {
  return { ...tenant };
}

function copyOrder(order: CustomerOrder): CustomerOrder {
  return {
    ...order,
    lines: order.lines.map((line) => ({ ...line, choices: line.choices.map((choice) => ({ ...choice })) })),
    fulfillment: order.fulfillment ? { ...order.fulfillment } : null
  };
}

function copyIntegration(config: TenantConfig): TenantConfig["orderIntegration"] {
  const integration = config.orderIntegration;
  if (!integration?.webhookUrl && !integration?.webhookSecret) return undefined;
  return {
    ...(integration.webhookUrl ? { webhookUrl: integration.webhookUrl } : {}),
    ...(integration.webhookSecret ? { webhookSecret: integration.webhookSecret } : {})
  };
}

function copyConfig(config: TenantConfig): TenantConfig {
  const llm = copyTenantLlmOverride(config.llm);
  const orderIntegration = copyIntegration(config);
  return {
    businessName: config.businessName,
    segment: config.segment,
    greeting: config.greeting,
    knowledge: (config.knowledge ?? []).map((entry) => ({ ...entry })),
    handoffKeywords: [...(config.handoffKeywords ?? [])],
    assistantMode: config.assistantMode ?? "approved_faq",
    version: config.version,
    profile: copyProfile(config.profile),
    catalog: copyCatalog(config.catalog),
    orderingEnabled: config.orderingEnabled === true,
    ...(orderIntegration ? { orderIntegration } : {}),
    ...(llm ? { llm } : {})
  };
}

function presentConfig(config: TenantConfig): TenantConfig {
  const copy = copyConfig(config);
  const llm = presentTenantLlmOverride(copy.llm);
  const { llm: _llm, orderIntegration, ...rest } = copy;
  const presentedIntegration = orderIntegration
    ? {
        ...(orderIntegration.webhookUrl ? { webhookUrl: orderIntegration.webhookUrl } : {}),
        webhookSecretConfigured: Boolean(orderIntegration.webhookSecret)
      }
    : undefined;
  return {
    ...rest,
    ...(presentedIntegration ? { orderIntegration: presentedIntegration } : {}),
    ...(llm ? { llm } : {})
  };
}

function copyConversation(conversation: Conversation): Conversation {
  return { ...conversation };
}

function copyMessage(message: Message): Message {
  return { ...message };
}

function normalizeForMatching(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assertOrderWebhook(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AttendanceError(400, "invalid_order_webhook", "URL de webhook inválida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" || url.username || url.password) {
    throw new AttendanceError(400, "invalid_order_webhook", "URL de webhook inválida.");
  }
  return url.toString();
}

function containsHandoffKeyword(text: string, keywords: readonly string[]): boolean {
  const normalizedText = ` ${normalizeForMatching(text)} `;
  return keywords.some((keyword) => {
    const normalizedKeyword = normalizeForMatching(keyword);
    return normalizedKeyword.length > 0 && normalizedText.includes(` ${normalizedKeyword} `);
  });
}

function approvedAnswer(text: string, knowledge: readonly KnowledgeEntry[]): string | undefined {
  const normalizedText = normalizeForMatching(text);
  if (!normalizedText) return undefined;

  return knowledge.find((entry) => normalizeForMatching(entry.question) === normalizedText)?.answer;
}

function isGreeting(text: string): boolean {
  const normalized = normalizeForMatching(text);
  return /^(oi|ola|bom dia|boa tarde|boa noite)$/.test(normalized);
}

function isTextMessage(type: InboundMessageType, text: string | undefined): text is string {
  return (type === "text" || type === "interactive" || type === "button") && Boolean(text?.trim());
}

function normalizeSlug(value: string): string {
  const slug = normalizeForMatching(value)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "tenant";
}

export class LocalAttendanceService {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly channelTenants = new Map<string, string>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly conversationKeys = new Map<string, string>();
  private readonly messages = new Map<string, Message[]>();
  private readonly processedInboundIds = new Set<string>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly workerIntervalMs: number;
  private readonly repository: AttendanceStateRepository | undefined;
  private readonly knowledgeAnswerSelector: KnowledgeAnswerSelector | undefined;
  private readonly llmAssistant: LlmAssistant | undefined;
  private readonly orderSink: OrderSink;
  private readonly outbound: LocalOutboundOptions | undefined;
  private readonly onCustomerMessage: ((event: CustomerMessageNotice) => void) | undefined;
  private readonly onOutboundMessage: ((event: OutboundMessageNotice) => void) | undefined;
  private readonly outbox = new Map<string, OutboxEntry>();
  private readonly orders = new Map<string, CustomerOrder>();
  private readonly changeListeners = new Map<string, Set<() => void>>();
  private workerTimer: ReturnType<typeof setInterval> | undefined;
  private pendingRun: Promise<void> | undefined;
  private outboxRun: Promise<void> | undefined;

  constructor(
    private readonly store: PendingInboundEventStore,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.workerIntervalMs = options.workerIntervalMs ?? 250;
    this.repository = options.repository;
    this.knowledgeAnswerSelector = options.knowledgeAnswerSelector;
    this.llmAssistant = options.llmAssistant;
    this.orderSink = options.orderSink ?? createWebhookOrderSink();
    this.outbound = options.outbound;
    this.onCustomerMessage = options.onCustomerMessage;
    this.onOutboundMessage = options.onOutboundMessage;
    if (this.outbound?.enabled && (
      !this.outbound.sender || !this.outbound.phoneNumberId || !this.outbound.accessToken ||
      !/^[1-9]\d{0,31}$/.test(this.outbound.phoneNumberId) ||
      this.outbound.allowedRecipients.length === 0 ||
      this.outbound.allowedRecipients.some((recipient) => !/^[1-9]\d{7,14}$/.test(recipient)) ||
      (this.outbound.maxTotalAttempts !== undefined && (!Number.isSafeInteger(this.outbound.maxTotalAttempts) || this.outbound.maxTotalAttempts < 1))
    )) {
      throw new Error("O envio WhatsApp local exige adaptador, canal e destinatários explicitamente configurados.");
    }

    const snapshot = this.repository?.load();
    if (snapshot) {
      this.restoreSnapshot(snapshot);
      this.recoverInterruptedOutbound();
      return;
    }

    for (const demo of demoTenants) {
      this.insertTenant(demo.tenant, {
        businessName: demo.tenant.displayName,
        segment: demo.tenant.segment,
        greeting: demo.greeting,
        knowledge: demo.knowledge,
        handoffKeywords: [...defaultHandoffKeywords],
        assistantMode: "approved_faq",
        profile: demo.tenant.segment === "pizzaria" ? pizzariaProfile : barbeariaProfile,
        catalog: demo.tenant.segment === "pizzaria" ? pizzariaCatalog : [],
        orderingEnabled: demo.tenant.segment === "pizzaria",
        version: 1
      });
    }

    // Mantém o alias utilizado pelo smoke test local sem aceitar outros nomes de canal.
    this.channelTenants.set("local-phone-number", "pizzaria-demo");
    this.repository?.save(this.createSnapshot());
  }

  listTenants(tenantIds: readonly string[]): Tenant[] {
    const allowed = new Set(tenantIds);
    return [...this.tenants.values()]
      .filter(({ tenant }) => allowed.has(tenant.id))
      .map(({ tenant }) => copyTenant(tenant));
  }

  subscribeToTenantChanges(tenantId: string, listener: () => void): () => void {
    this.getTenantRecord(tenantId);
    const listeners = this.changeListeners.get(tenantId) ?? new Set<() => void>();
    listeners.add(listener);
    this.changeListeners.set(tenantId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.changeListeners.delete(tenantId);
    };
  }

  createTenant(input: CreateTenantInput): Tenant {
    return this.mutateState(() => {
      const id = this.createId();
      const baseSlug = normalizeSlug(input.displayName);
      const slug = `${baseSlug}-${id.slice(0, 8)}`;
      const tenant: Tenant = {
        id,
        slug,
        displayName: input.displayName,
        segment: input.segment,
        channelPhoneNumberId: `demo-local-${id.slice(0, 12)}`
      };
      const config: TenantConfig = {
        businessName: input.displayName,
        segment: input.segment,
        greeting: `Olá! Sou o assistente virtual de ${input.displayName}. Como posso ajudar?`,
        knowledge: [],
        handoffKeywords: [...defaultHandoffKeywords],
        assistantMode: "approved_faq",
        profile: emptyProfile(),
        catalog: [],
        orderingEnabled: false,
        version: 1
      };

      this.insertTenant(tenant, config);
      return copyTenant(tenant);
    });
  }

  bindTestChannel(tenantId: string, phoneNumberId: string): Tenant {
    if (!/^[1-9][0-9]{0,31}$/.test(phoneNumberId)) {
      throw new AttendanceError(400, "invalid_test_phone_number_id", "O ID do número de teste é inválido.");
    }

    const record = this.getTenantRecord(tenantId);
    const currentOwner = this.channelTenants.get(phoneNumberId);
    if (currentOwner && currentOwner !== tenantId) {
      throw new AttendanceError(409, "channel_already_bound", "Este canal já está associado a outra empresa.");
    }
    if (record.tenant.channelPhoneNumberId === phoneNumberId) return copyTenant(record.tenant);

    return this.mutateTenantState(tenantId, () => {
      const owner = this.channelTenants.get(phoneNumberId);
      if (owner && owner !== tenantId) {
        throw new AttendanceError(409, "channel_already_bound", "Este canal já está associado a outra empresa.");
      }
      this.channelTenants.delete(record.tenant.channelPhoneNumberId);
      record.tenant.channelPhoneNumberId = phoneNumberId;
      this.channelTenants.set(phoneNumberId, tenantId);
      return copyTenant(record.tenant);
    });
  }

  getConfig(tenantId: string): { tenant: Tenant; config: TenantConfig } {
    const record = this.getTenantRecord(tenantId);
    return { tenant: copyTenant(record.tenant), config: presentConfig(record.config) };
  }

  reloadFromRepository(): void {
    if (!this.repository) {
      throw new Error("Não é possível recarregar o atendimento sem um repositório persistente.");
    }
    const snapshot = this.repository.load();
    if (!snapshot) {
      throw new Error("O repositório não contém um snapshot de atendimento para recarregar.");
    }
    this.restoreSnapshot(snapshot);
  }

  updateConfig(tenantId: string, input: UpdateTenantConfigInput): { tenant: Tenant; config: TenantConfig } {
    const record = this.getTenantRecord(tenantId);
    if (record.config.version !== input.version) {
      throw new AttendanceError(409, "config_version_conflict", "A configuração foi alterada por outra sessão.");
    }

    return this.mutateTenantState(tenantId, () => {
      record.tenant.displayName = input.businessName;
      record.tenant.segment = input.segment;
      let llm: TenantConfig["llm"];
      try {
        llm = mergeTenantLlmUpdate(record.config.llm, input.llm);
      } catch (error) {
        if (error instanceof LlmSettingsError) {
          throw new AttendanceError(400, "invalid_llm_override", error.message);
        }
        throw error;
      }
      const profile = input.profile ? copyProfile(input.profile) : copyProfile(record.config.profile);
      const catalog = input.catalog ? copyCatalog(input.catalog) : copyCatalog(record.config.catalog);
      if (input.catalog) {
        try {
          assertCatalog(catalog);
        } catch (error) {
          if (error instanceof CatalogError) throw new AttendanceError(400, "invalid_catalog", error.message);
          throw error;
        }
      }
      let orderIntegration = copyIntegration(record.config);
      if (input.orderIntegration === null) orderIntegration = undefined;
      else if (input.orderIntegration) {
        const webhookUrl = input.orderIntegration.webhookUrl === undefined
          ? orderIntegration?.webhookUrl
          : input.orderIntegration.webhookUrl.trim()
            ? assertOrderWebhook(input.orderIntegration.webhookUrl.trim())
            : undefined;
        const secret = input.orderIntegration.webhookSecret === null
          ? undefined
          : input.orderIntegration.webhookSecret ?? orderIntegration?.webhookSecret;
        if (secret && (secret.length < 8 || /\s/.test(secret))) {
          throw new AttendanceError(400, "invalid_order_webhook", "O segredo do webhook precisa ter ao menos 8 caracteres.");
        }
        orderIntegration = webhookUrl || secret
          ? { ...(webhookUrl ? { webhookUrl } : {}), ...(secret ? { webhookSecret: secret } : {}) }
          : undefined;
      }
      record.config = {
        businessName: input.businessName,
        segment: input.segment,
        greeting: input.greeting,
        knowledge: input.knowledge.map((entry) => ({ ...entry })),
        handoffKeywords: [...input.handoffKeywords],
        assistantMode: input.assistantMode ?? record.config.assistantMode ?? "approved_faq",
        profile,
        catalog,
        orderingEnabled: input.orderingEnabled ?? record.config.orderingEnabled,
        version: record.config.version + 1,
        ...(orderIntegration ? { orderIntegration } : {}),
        ...(llm ? { llm } : {})
      };
      return { tenant: copyTenant(record.tenant), config: presentConfig(record.config) };
    });
  }

  listConversations(tenantId: string, state?: ConversationState): Conversation[] {
    this.getTenantRecord(tenantId);
    return [...this.conversations.values()]
      .filter((conversation) => conversation.tenantId === tenantId && (!state || conversation.state === state))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(copyConversation);
  }

  getConversation(tenantId: string, conversationId: string): {
    conversation: Conversation;
    messages: Message[];
  } {
    const conversation = this.getConversationRecord(tenantId, conversationId);
    return {
      conversation: copyConversation(conversation),
      messages: (this.messages.get(conversationId) ?? []).map(copyMessage)
    };
  }

  listOrders(tenantId: string): CustomerOrder[] {
    this.getTenantRecord(tenantId);
    return [...this.orders.values()]
      .filter((order) => order.tenantId === tenantId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(copyOrder);
  }

  getOrder(tenantId: string, orderId: string): CustomerOrder {
    this.getTenantRecord(tenantId);
    const order = this.orders.get(orderId);
    if (!order || order.tenantId !== tenantId) {
      throw new AttendanceError(404, "order_not_found", "Pedido não encontrado.");
    }
    return copyOrder(order);
  }

  updateOrderStatus(tenantId: string, orderId: string, status: "cancelled" | "sent_to_integration"): CustomerOrder {
    const order = this.orders.get(orderId);
    if (!order || order.tenantId !== tenantId) {
      throw new AttendanceError(404, "order_not_found", "Pedido não encontrado.");
    }
    return this.mutateTenantState(tenantId, () => {
      const current = this.orders.get(orderId);
      if (!current || current.tenantId !== tenantId) {
        throw new AttendanceError(404, "order_not_found", "Pedido não encontrado.");
      }
      const allowed = status === "cancelled"
        ? current.status === "draft" || current.status === "awaiting_confirmation" || current.status === "confirmed"
        : current.status === "confirmed";
      if (!allowed) {
        throw new AttendanceError(409, "invalid_order_status", "Esta mudança de status não é permitida.");
      }
      const now = this.now().toISOString();
      current.status = status;
      current.updatedAt = now;
      if (status === "cancelled") current.cancelledAt = now;
      if (status === "sent_to_integration" && !current.integrationReference) current.integrationReference = "manual";
      return copyOrder(current);
    });
  }

  listOutbox(tenantId: string): OutboxEntry[] {
    this.getTenantRecord(tenantId);
    return [...this.outbox.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((entry) => ({ ...entry }));
  }

  async simulateMessage(tenantId: string, input: SimulateMessageInput): Promise<SimulateMessageResult> {
    const record = this.getTenantRecord(tenantId);
    const clientId = input.clientMessageId ?? this.createId();
    const eventId = `sim:${tenantId}:${clientId}`;
    const event: NormalizedInboundMessage = {
      provider: "META_WHATSAPP",
      source: "LOCAL_SIMULATOR",
      providerEventId: eventId,
      providerPhoneNumberId: record.tenant.channelPhoneNumberId,
      consumerPhoneNumber: input.customerPhone,
      consumerProfileName: input.customerName,
      occurredAt: this.now(),
      type: "text",
      text: input.text,
      rawMessage: { source: "local-simulator", tenantId, customerName: input.customerName, text: input.text }
    };

    const result = await this.store.enqueue(event);
    if (result === "UNKNOWN_CHANNEL") {
      throw new AttendanceError(404, "tenant_channel_not_found", "Canal local não encontrado.");
    }
    return { eventId, status: result === "DUPLICATE" ? "DUPLICATE" : "PENDING" };
  }

  handoff(tenantId: string, conversationId: string): Conversation {
    const conversation = this.getConversationRecord(tenantId, conversationId);
    if (conversation.state === "WAITING_HUMAN") return copyConversation(conversation);
    return this.mutateTenantState(tenantId, () => {
      this.transition(conversation, "WAITING_HUMAN");
      conversation.assignedUserId = null;
      conversation.waitingSince = this.now().toISOString();
      conversation.updatedAt = this.now().toISOString();
      return copyConversation(conversation);
    });
  }

  claim(tenantId: string, conversationId: string, userId: string): Conversation {
    const conversation = this.getConversationRecord(tenantId, conversationId);
    if (conversation.state !== "WAITING_HUMAN" || conversation.assignedUserId !== null) {
      throw new AttendanceError(409, "conversation_claim_conflict", "A conversa já foi assumida ou não aguarda atendente.");
    }

    // Checagem e gravação sem await formam o compare-and-set no store local de processo único.
    return this.mutateTenantState(tenantId, () => {
      this.transition(conversation, "HUMAN_ACTIVE");
      conversation.assignedUserId = userId;
      conversation.waitingSince = null;
      conversation.updatedAt = this.now().toISOString();
      return copyConversation(conversation);
    });
  }

  reply(
    tenantId: string,
    conversationId: string,
    user: { id: string; displayName: string },
    text: string
  ): { message: Message; conversation: Conversation } {
    const conversation = this.getConversationRecord(tenantId, conversationId);
    this.assertOwner(conversation, user.id);
    return this.mutateTenantState(tenantId, () => {
      const createdAt = this.now().toISOString();
      const message: Message = {
        id: this.createId(),
        conversationId,
        role: "ATTENDANT",
        text,
        createdAt,
        deliveryStatus: "SIMULATED",
        authorName: user.displayName
      };
      this.pushMessage(message);
      this.createOutboxEntry(conversation, message);
      conversation.lastMessagePreview = text;
      conversation.updatedAt = createdAt;
      this.notifyOutbound(conversation, message);
      return { message: copyMessage(message), conversation: copyConversation(conversation) };
    });
  }

  close(tenantId: string, conversationId: string, userId: string): Conversation {
    const conversation = this.getConversationRecord(tenantId, conversationId);
    if (conversation.state === "HUMAN_ACTIVE") this.assertOwner(conversation, userId);
    return this.mutateTenantState(tenantId, () => {
      this.transition(conversation, "CLOSED");
      conversation.assignedUserId = null;
      conversation.waitingSince = null;
      conversation.updatedAt = this.now().toISOString();
      return copyConversation(conversation);
    });
  }

  resume(tenantId: string, conversationId: string, userId: string): Conversation {
    const conversation = this.getConversationRecord(tenantId, conversationId);
    if (conversation.state === "HUMAN_ACTIVE") this.assertOwner(conversation, userId);
    if (conversation.state !== "WAITING_HUMAN" && conversation.state !== "HUMAN_ACTIVE") {
      throw new AttendanceError(409, "invalid_conversation_state", "Somente conversas aguardando ou em atendimento podem ser retomadas.");
    }
    return this.mutateTenantState(tenantId, () => {
      this.transition(conversation, "BOT_ACTIVE");
      conversation.assignedUserId = null;
      conversation.waitingSince = null;
      conversation.updatedAt = this.now().toISOString();
      return copyConversation(conversation);
    });
  }

  startWorker(): void {
    if (this.workerTimer) return;
    this.workerTimer = setInterval(() => {
      void this.processPending().then(() => this.processOutbox()).catch(() => {
        // Itens que falharam são recolocados na fila para uma tentativa posterior.
      });
    }, this.workerIntervalMs);
    this.workerTimer.unref?.();
    void this.processPending().then(() => this.processOutbox()).catch(() => undefined);
  }

  async stopWorker(): Promise<void> {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = undefined;
    }
    await this.pendingRun?.catch(() => {
      // Uma falha já foi reencaminhada para o store; o fechamento ainda pode prosseguir.
    });
  }

  processPending(): Promise<void> {
    if (this.pendingRun) return this.pendingRun;
    const run = this.drainPending();
    const trackedRun = run.finally(() => {
      if (this.pendingRun === trackedRun) this.pendingRun = undefined;
    });
    this.pendingRun = trackedRun;
    return trackedRun;
  }

  processOutbox(): Promise<void> {
    if (!this.outbound?.enabled) return Promise.resolve();
    if (this.outboxRun) return this.outboxRun;
    const run = this.drainOutbox();
    const trackedRun = run.finally(() => {
      if (this.outboxRun === trackedRun) this.outboxRun = undefined;
    });
    this.outboxRun = trackedRun;
    return trackedRun;
  }

  private async drainPending(): Promise<void> {
    while (true) {
      const event = await this.store.takePending();
      if (!event) return;
      try {
        await this.processInbound(event);
        await this.store.acknowledge?.(event);
      } catch (error) {
        await this.store.requeue(event);
        throw error;
      }
      await this.processOutbox();
    }
  }

  private async drainOutbox(): Promise<void> {
    while (true) {
      const maxTotalAttempts = this.outbound?.maxTotalAttempts;
      if (maxTotalAttempts !== undefined) {
        const attemptsAlreadyMade = [...this.outbox.values()].reduce((total, entry) => total + entry.attemptCount, 0);
        if (attemptsAlreadyMade >= maxTotalAttempts) {
          for (const entry of this.outbox.values()) {
            if (entry.status === "PENDING") {
              this.finishOutbox(entry.id, "BLOCKED", "test_send_limit_reached", "test_send_limit_reached");
            }
          }
          return;
        }
      }
      const pending = [...this.outbox.values()].find((entry) => entry.status === "PENDING" && entry.source !== "WHATSAPP_QR");
      if (!pending) return;
      const conversation = this.conversations.get(pending.conversationId);
      const message = (this.messages.get(pending.conversationId) ?? []).find((item) => item.id === pending.messageId);
      const tenant = this.tenants.get(pending.tenantId)?.tenant;
      if (!conversation || !message || !tenant) {
        this.finishOutbox(pending.id, "BLOCKED", null, "record_missing");
        continue;
      }

      const blockedReason = this.outboundBlockReason(conversation, tenant.channelPhoneNumberId, pending);
      if (blockedReason) {
        this.finishOutbox(pending.id, "BLOCKED", blockedReason, blockedReason);
        continue;
      }

      const recipient = this.outboundRecipient(conversation.customerPhone);
      const lastInboundAt = pending.lastInboundAt ? new Date(pending.lastInboundAt) : undefined;
      if (!recipient || !lastInboundAt || !this.outbound?.sender) {
        this.finishOutbox(pending.id, "BLOCKED", "missing_inbound_context", "dispatch_context_missing");
        continue;
      }

      const attemptedAt = this.now().toISOString();
      this.mutateTenantState(pending.tenantId, () => {
        const entry = this.outbox.get(pending.id);
        if (!entry || entry.status !== "PENDING") return;
        entry.status = "SENDING";
        entry.attemptCount = 1;
        entry.attemptedAt = attemptedAt;
        message.deliveryStatus = "SENDING";
      });

      let result;
      try {
        result = await this.outbound.sender.sendText({
          recipient,
          body: message.text,
          lastInboundAt
        });
      } catch {
        result = { status: "INDETERMINATE", reason: "network_error" } as const;
      }

      const completedAt = this.now().toISOString();
      this.mutateTenantState(pending.tenantId, () => {
        const entry = this.outbox.get(pending.id);
        if (!entry || entry.status !== "SENDING") return;
        entry.status = result.status;
        entry.completedAt = completedAt;
        entry.blockedReason = null;
        entry.resultCode = result.status === "HTTP_ERROR" ? result.category
          : result.status === "INDETERMINATE" ? result.reason
          : result.status === "BLOCKED" ? result.reason
          : null;
        entry.providerMessageId = result.status === "ACCEPTED" ? result.providerMessageId : null;
        message.deliveryStatus = result.status;
      });
    }
  }

  private finishOutbox(
    id: string,
    status: "BLOCKED",
    reason: OutboundBlockReason | null,
    resultCode: string
  ): void {
    const entry = this.outbox.get(id);
    if (!entry) return;
    this.mutateTenantState(entry.tenantId, () => {
      const entry = this.outbox.get(id);
      if (!entry || entry.status !== "PENDING") return;
      entry.status = status;
      entry.blockedReason = reason;
      entry.resultCode = resultCode;
      entry.completedAt = this.now().toISOString();
      const message = (this.messages.get(entry.conversationId) ?? []).find((item) => item.id === entry.messageId);
      if (message) message.deliveryStatus = status;
    });
  }

  private createOutboxEntry(conversation: Conversation, message: Message): void {
    const tenant = this.getTenantRecord(conversation.tenantId).tenant;
    const qrReply = conversation.lastInboundSource === "WHATSAPP_QR";
    const blockedReason = qrReply ? null : this.outboundBlockReason(conversation, tenant.channelPhoneNumberId);
    const status: OutboundStatus = qrReply
      ? "PENDING"
      : !this.outbound?.enabled
        ? "SIMULATED"
        : blockedReason ? "BLOCKED" : "PENDING";
    message.deliveryStatus = status;
    if (!qrReply) message.deliveryDetail = null;
    const entry: OutboxEntry = {
      id: message.id,
      tenantId: conversation.tenantId,
      conversationId: conversation.id,
      messageId: message.id,
      sourceInboundMessageId: conversation.lastInboundMessageId,
      source: conversation.lastInboundSource,
      phoneNumberId: conversation.lastInboundPhoneNumberId,
      lastInboundAt: conversation.lastInboundAt,
      status,
      blockedReason: this.outbound?.enabled ? blockedReason : null,
      attemptCount: 0,
      providerMessageId: null,
      resultCode: qrReply ? null : !this.outbound?.enabled ? "outbound_disabled" : blockedReason,
      createdAt: message.createdAt,
      attemptedAt: null,
      completedAt: status === "BLOCKED" ? message.createdAt : null
    };
    this.outbox.set(entry.id, entry);
  }

  private outboundBlockReason(
    conversation: Conversation,
    currentPhoneNumberId: string,
    intent?: OutboxEntry
  ): OutboundBlockReason | null {
    if (!this.outbound?.enabled) return null;
    const source = intent ? intent.source : conversation.lastInboundSource;
    const inboundMessageId = intent ? intent.sourceInboundMessageId : conversation.lastInboundMessageId;
    const inboundPhoneNumberId = intent ? intent.phoneNumberId : conversation.lastInboundPhoneNumberId;
    const inboundAt = intent ? intent.lastInboundAt : conversation.lastInboundAt;
    if (
      source !== "META_WEBHOOK" || !inboundMessageId || !inboundPhoneNumberId || !inboundAt
    ) return source === "LOCAL_SIMULATOR" ? "source_not_meta" : "missing_inbound_context";
    if (intent && (
      intent.sourceInboundMessageId !== conversation.lastInboundMessageId ||
      intent.source !== conversation.lastInboundSource ||
      intent.phoneNumberId !== conversation.lastInboundPhoneNumberId ||
      intent.lastInboundAt !== conversation.lastInboundAt
    )) return "missing_inbound_context";
    if (
      !this.outbound.phoneNumberId || inboundPhoneNumberId !== this.outbound.phoneNumberId ||
      currentPhoneNumberId !== this.outbound.phoneNumberId
    ) return "channel_mismatch";
    const recipient = this.outboundRecipient(conversation.customerPhone);
    if (!recipient) return "invalid_recipient";
    if (!this.outbound.allowedRecipients.includes(recipient)) return "recipient_not_allowlisted";
    const timestamp = Date.parse(inboundAt);
    if (!Number.isFinite(timestamp)) return "invalid_inbound_timestamp";
    const age = this.now().getTime() - timestamp;
    if (age < 0) return "future_inbound_timestamp";
    if (age >= outboundServiceWindowMs) return "service_window_expired";
    return null;
  }

  private outboundRecipient(value: string): string | undefined {
    const match = /^\+?([1-9]\d{7,14})$/.exec(value);
    return match?.[1];
  }

  private recoverInterruptedOutbound(): void {
    let recovered = false;
    for (const entry of this.outbox.values()) {
      if (entry.status !== "SENDING") continue;
      entry.status = "INDETERMINATE";
      entry.resultCode = "process_restarted_during_send";
      entry.completedAt = this.now().toISOString();
      const message = (this.messages.get(entry.conversationId) ?? []).find((item) => item.id === entry.messageId);
      if (message) message.deliveryStatus = "INDETERMINATE";
      recovered = true;
    }
    if (recovered) this.repository?.save(this.createSnapshot());
  }

  private async processInbound(event: NormalizedInboundMessage): Promise<void> {
    const tenantId = this.channelTenants.get(event.providerPhoneNumberId);
    if (!tenantId) return;

    const dedupeKey = `${tenantId}:${event.provider}:${event.providerEventId}`;
    if (this.processedInboundIds.has(dedupeKey)) return;

    const customerPhone = event.consumerPhoneNumber.trim();
    if (!customerPhone) return;
    const record = this.getTenantRecord(tenantId);
    const text = event.text?.trim() ?? "";
    const textMessage = isTextMessage(event.type, event.text);
    const existingId = this.conversationKeys.get(`${tenantId}:${customerPhone}`);
    const existing = existingId ? this.conversations.get(existingId) : undefined;
    const scheduling = textMessage && isSchedulingOrQuote(text);
    const orderIntent = textMessage && (isOrderIntent(text) || textMentionsItem(text, record.config.catalog));
    const orderingActive = record.config.orderingEnabled && record.config.catalog.some((item) => item.available);
    const openOrder = existing ? this.openOrder(existing.id) : undefined;
    const routeToOrdering = Boolean(this.llmAssistant) && orderingActive && !scheduling && (orderIntent || Boolean(openOrder));
    const initiallyHandled =
      !textMessage ||
      containsHandoffKeyword(text, record.config.handoffKeywords) ||
      scheduling ||
      (orderIntent && !routeToOrdering);
    const canUseBot = !existing || existing.state === "BOT_ACTIVE" || existing.state === "CLOSED";
    const exactAnswer = textMessage && !routeToOrdering ? approvedAnswer(text, record.config.knowledge) : undefined;
    const greeting = textMessage && !routeToOrdering && isGreeting(text) ? record.config.greeting : undefined;
    let selectedKnowledge: KnowledgeEntry | undefined;
    const selectorEligible =
      canUseBot && !routeToOrdering && !initiallyHandled && !exactAnswer && !greeting &&
      record.config.assistantMode === "local_ai" && this.knowledgeAnswerSelector && record.config.knowledge.length > 0;
    if (selectorEligible && this.knowledgeAnswerSelector) {
      const knowledgeSnapshot = record.config.knowledge.map((entry) => ({ ...entry }));
      try {
        const selectedIndex = await this.knowledgeAnswerSelector.selectAnswerIndex({
          businessName: record.config.businessName,
          segment: record.config.segment,
          customerText: text,
          knowledge: knowledgeSnapshot
        });
        if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < knowledgeSnapshot.length) {
          selectedKnowledge = knowledgeSnapshot[selectedIndex];
        }
      } catch {
        // Falha fechada: sem classificação local, a mensagem será encaminhada a uma pessoa.
      }
    }
    let llmOutcome: LlmTurnOutcome | undefined;
    let producedOrder: CustomerOrder | null = null;
    let plannedConversationId: string | undefined;
    if (canUseBot && !initiallyHandled && !exactAnswer && !greeting && !selectorEligible && this.llmAssistant) {
      const knowledgeSnapshot = record.config.knowledge.map((entry) => ({ ...entry }));
      const override = copyTenantLlmOverride(record.config.llm);
      plannedConversationId = existing?.id ?? this.createId();
      const session = orderingActive
        ? new OrderSession({
            tenantId,
            conversationId: plannedConversationId,
            catalog: copyCatalog(record.config.catalog),
            profile: copyProfile(record.config.profile),
            existing: openOrder ? copyOrder(openOrder) : null,
            customerText: text,
            now: this.now,
            createId: this.createId,
            sink: this.orderSink,
            ...(record.config.orderIntegration?.webhookUrl ? { webhookUrl: record.config.orderIntegration.webhookUrl } : {}),
            ...(record.config.orderIntegration?.webhookSecret ? { webhookSecret: record.config.orderIntegration.webhookSecret } : {})
          })
        : undefined;
      try {
        llmOutcome = await this.llmAssistant.completeTurn({
          businessName: record.config.businessName,
          segment: record.config.segment,
          customerText: text,
          knowledge: knowledgeSnapshot,
          profile: copyProfile(record.config.profile),
          catalog: copyCatalog(record.config.catalog),
          orderingEnabled: orderingActive,
          order: openOrder ? copyOrder(openOrder) : null,
          ...(session ? { session } : {}),
          ...(override ? { override } : {})
        });
        producedOrder = session?.order() ?? null;
      } catch {
        llmOutcome = this.llmFailureOutcome();
      }
    }
    this.mutateTenantState(tenantId, () => {
      if (this.processedInboundIds.has(dedupeKey)) return;

      const currentRecord = this.getTenantRecord(tenantId);
      const conversationKey = `${tenantId}:${customerPhone}`;
      let conversationId = this.conversationKeys.get(conversationKey);
      let conversation = conversationId ? this.conversations.get(conversationId) : undefined;
      const now = this.now().toISOString();

      if (!conversation) {
        conversationId = plannedConversationId ?? this.createId();
        conversation = {
          id: conversationId,
          tenantId,
          customerName: event.consumerProfileName?.trim() || customerPhone,
          customerPhone,
          state: "BOT_ACTIVE",
          assignedUserId: null,
          createdAt: now,
          updatedAt: now,
          lastMessagePreview: "",
          waitingSince: null,
          lastInboundMessageId: null,
          lastInboundSource: null,
          lastInboundPhoneNumberId: null,
          lastInboundAt: null
        };
        this.conversations.set(conversationId, conversation);
        this.conversationKeys.set(conversationKey, conversationId);
        this.messages.set(conversationId, []);
      } else if (conversation.state === "CLOSED") {
        this.transition(conversation, "BOT_ACTIVE");
        conversation.assignedUserId = null;
        conversation.waitingSince = null;
      }

      const messageText = text || `[${event.type === "unknown" ? "mensagem" : event.type} recebida]`;
      const customerMessage: Message = {
        id: this.createId(),
        conversationId: conversation.id,
        role: "CUSTOMER",
        text: messageText,
        createdAt: Number.isFinite(event.occurredAt.getTime()) ? event.occurredAt.toISOString() : now,
        deliveryStatus: "RECEIVED",
        authorName: event.consumerProfileName?.trim() || null
      };
      this.pushMessage(customerMessage);
      conversation.lastInboundMessageId = customerMessage.id;
      conversation.lastInboundSource = event.source ?? "LEGACY_UNKNOWN";
      conversation.lastInboundPhoneNumberId = event.providerPhoneNumberId;
      conversation.lastInboundAt = customerMessage.createdAt;
      conversation.lastMessagePreview = messageText;
      conversation.updatedAt = now;
      this.notifyCustomer({
        tenantId,
        phone: customerPhone,
        text: messageText,
        at: customerMessage.createdAt,
        messageId: customerMessage.id,
        source: event.source ?? "LEGACY_UNKNOWN"
      });

      if (conversation.state === "BOT_ACTIVE") {
        const currentOrdering = currentRecord.config.orderingEnabled && currentRecord.config.catalog.some((item) => item.available);
        const currentRoute = Boolean(this.llmAssistant) && currentOrdering && !scheduling && (orderIntent || Boolean(openOrder));
        const shouldHandoff =
          !textMessage ||
          containsHandoffKeyword(text, currentRecord.config.handoffKeywords) ||
          scheduling ||
          (orderIntent && !currentRoute);
        if (shouldHandoff) {
          this.transition(conversation, "WAITING_HUMAN");
          conversation.waitingSince = now;
        } else {
          const answer = approvedAnswer(text, currentRecord.config.knowledge);
          const safeSelectedAnswer = currentRecord.config.assistantMode === "local_ai" && selectedKnowledge
            ? currentRecord.config.knowledge.find((entry) =>
                entry.question === selectedKnowledge?.question && entry.answer === selectedKnowledge.answer
              )?.answer
            : undefined;
          const response = routeToOrdering
            ? undefined
            : answer ?? (isGreeting(text) ? currentRecord.config.greeting : undefined) ?? safeSelectedAnswer;
          if (producedOrder) this.orders.set(producedOrder.id, producedOrder);
          if (response) {
            this.appendBotReply(conversation, response, now);
          } else if (!selectorEligible && llmOutcome?.kind === "reply") {
            this.appendBotReply(conversation, llmOutcome.text, now);
          } else if (!selectorEligible && llmOutcome?.kind === "reply_and_handoff") {
            this.appendBotReply(conversation, llmOutcome.text, now);
            this.transition(conversation, "WAITING_HUMAN");
            conversation.waitingSince = now;
          } else if (!selectorEligible && llmOutcome?.kind === "handoff") {
            if (llmOutcome.text) this.appendBotReply(conversation, llmOutcome.text, now);
            this.transition(conversation, "WAITING_HUMAN");
            conversation.waitingSince = now;
          } else {
            this.transition(conversation, "WAITING_HUMAN");
            conversation.waitingSince = now;
          }
        }
      }

      // A mensagem só se torna deduplicada depois que todos os efeitos estão prontos.
      // mutateState grava esse ID junto com conversa e histórico, ou desfaz os três.
      this.processedInboundIds.add(dedupeKey);
    });
  }

  private mutateState<T>(mutation: () => T): T {
    if (!this.repository) return mutation();

    const previous = this.createSnapshot();
    try {
      const result = mutation();
      this.repository.save(this.createSnapshot());
      return result;
    } catch (error) {
      this.restoreSnapshot(previous);
      throw error;
    }
  }

  private mutateTenantState<T>(tenantId: string, mutation: () => T): T {
    const result = this.mutateState(mutation);
    this.publishTenantChange(tenantId);
    return result;
  }

  private publishTenantChange(tenantId: string): void {
    for (const listener of this.changeListeners.get(tenantId) ?? []) {
      try {
        listener();
      } catch {
        // A disconnected stream must not interfere with a committed attendance update.
      }
    }
  }

  private createSnapshot(): AttendanceSnapshot {
    return {
      tenants: [...this.tenants.values()].map(({ tenant, config }) => ({
        tenant: copyTenant(tenant),
        config: copyConfig(config)
      })),
      conversations: [...this.conversations.values()].map(copyConversation),
      messages: [...this.messages.values()].flatMap((items) => items.map(copyMessage)),
      outbox: [...this.outbox.values()].map((entry) => ({ ...entry })),
      orders: [...this.orders.values()].map(copyOrder),
      processedInboundIds: [...this.processedInboundIds]
    };
  }

  private restoreSnapshot(snapshot: AttendanceSnapshot): void {
    if (
      !snapshot ||
      !Array.isArray(snapshot.tenants) ||
      !Array.isArray(snapshot.conversations) ||
      !Array.isArray(snapshot.messages) ||
      !Array.isArray(snapshot.outbox) ||
      !Array.isArray(snapshot.processedInboundIds)
    ) {
      throw new Error("Snapshot de atendimento local inválido.");
    }

    const tenants = new Map<string, TenantRecord>();
    const channelTenants = new Map<string, string>();
    for (const entry of snapshot.tenants) {
      const tenant = copyTenant(entry.tenant);
      const config = copyConfig(entry.config);
      if (!tenant.id || !tenant.channelPhoneNumberId || tenants.has(tenant.id)) {
        throw new Error("Snapshot de atendimento contém empresa inválida ou duplicada.");
      }
      if (channelTenants.has(tenant.channelPhoneNumberId)) {
        throw new Error("Snapshot de atendimento contém canal duplicado.");
      }
      tenants.set(tenant.id, { tenant, config });
      channelTenants.set(tenant.channelPhoneNumberId, tenant.id);
    }
    if (tenants.has("pizzaria-demo") && !channelTenants.has("local-phone-number")) {
      channelTenants.set("local-phone-number", "pizzaria-demo");
    }

    const conversations = new Map<string, Conversation>();
    const conversationKeys = new Map<string, string>();
    const messages = new Map<string, Message[]>();
    for (const item of snapshot.conversations) {
      const conversation = copyConversation(item);
      if (!tenants.has(conversation.tenantId) || conversations.has(conversation.id)) {
        throw new Error("Snapshot de atendimento contém conversa órfã ou duplicada.");
      }
      const key = `${conversation.tenantId}:${conversation.customerPhone}`;
      if (conversationKeys.has(key)) {
        throw new Error("Snapshot de atendimento contém mais de uma conversa para o mesmo cliente.");
      }
      conversations.set(conversation.id, conversation);
      conversationKeys.set(key, conversation.id);
      messages.set(conversation.id, []);
    }
    for (const item of snapshot.messages) {
      const message = copyMessage(item);
      const conversationMessages = messages.get(message.conversationId);
      if (!conversationMessages) {
        throw new Error("Snapshot de atendimento contém mensagem sem conversa.");
      }
      conversationMessages.push(message);
    }
    const outbox = new Map<string, OutboxEntry>();
    for (const item of snapshot.outbox) {
      const entry = { ...item };
      const conversation = conversations.get(entry.conversationId);
      const linkedMessage = messages.get(entry.conversationId)?.find((message) => message.id === entry.messageId);
      const validAttemptCount = Number.isInteger(entry.attemptCount) && (
        ["SIMULATED", "PENDING"].includes(entry.status) ? entry.attemptCount === 0
          : entry.status === "BLOCKED" ? entry.attemptCount === 0 || entry.attemptCount === 1
          : entry.attemptCount === 1
      );
      if (
        !entry.id || entry.id !== entry.messageId || outbox.has(entry.id) || !conversation ||
        !linkedMessage || conversation.tenantId !== entry.tenantId || !validAttemptCount ||
        !["SIMULATED", "PENDING", "SENDING", "ACCEPTED", "BLOCKED", "HTTP_ERROR", "INDETERMINATE"].includes(entry.status) ||
        linkedMessage.deliveryStatus !== entry.status
      ) {
        throw new Error("Snapshot de atendimento contém registro outbox órfão ou inválido.");
      }
      outbox.set(entry.id, entry);
    }
    const processedInboundIds = new Set<string>();
    for (const id of snapshot.processedInboundIds) {
      if (typeof id !== "string" || !id || processedInboundIds.has(id)) {
        throw new Error("Snapshot de atendimento contém ID inbound inválido ou duplicado.");
      }
      processedInboundIds.add(id);
    }

    const orders = new Map<string, CustomerOrder>();
    for (const item of snapshot.orders ?? []) {
      const order = copyOrder(item);
      const conversation = conversations.get(order.conversationId);
      if (
        !order.id || orders.has(order.id) || !conversation || conversation.tenantId !== order.tenantId ||
        !["draft", "awaiting_confirmation", "confirmed", "sent_to_integration", "cancelled"].includes(order.status)
      ) {
        throw new Error("Snapshot de atendimento contém pedido órfão ou inválido.");
      }
      orders.set(order.id, order);
    }

    this.tenants.clear();
    this.channelTenants.clear();
    this.conversations.clear();
    this.conversationKeys.clear();
    this.messages.clear();
    this.outbox.clear();
    this.orders.clear();
    this.processedInboundIds.clear();
    for (const [id, record] of tenants) this.tenants.set(id, record);
    for (const [channelId, tenantId] of channelTenants) this.channelTenants.set(channelId, tenantId);
    for (const [id, conversation] of conversations) this.conversations.set(id, conversation);
    for (const [key, id] of conversationKeys) this.conversationKeys.set(key, id);
    for (const [id, items] of messages) this.messages.set(id, items);
    for (const [id, entry] of outbox) this.outbox.set(id, entry);
    for (const id of processedInboundIds) this.processedInboundIds.add(id);
    this.orders.clear();
    for (const [id, order] of orders) this.orders.set(id, order);
  }

  private openOrder(conversationId: string): CustomerOrder | undefined {
    return [...this.orders.values()].find((order) =>
      order.conversationId === conversationId && (order.status === "draft" || order.status === "awaiting_confirmation")
    );
  }

  private insertTenant(tenant: Tenant, config: TenantConfig): void {
    this.tenants.set(tenant.id, { tenant: copyTenant(tenant), config: copyConfig(config) });
    this.channelTenants.set(tenant.channelPhoneNumberId, tenant.id);
  }

  private getTenantRecord(tenantId: string): TenantRecord {
    const record = this.tenants.get(tenantId);
    if (!record) throw new AttendanceError(404, "tenant_not_found", "Empresa não encontrada.");
    return record;
  }

  private getConversationRecord(tenantId: string, conversationId: string): Conversation {
    this.getTenantRecord(tenantId);
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.tenantId !== tenantId) {
      throw new AttendanceError(404, "conversation_not_found", "Conversa não encontrada.");
    }
    return conversation;
  }

  private transition(conversation: Conversation, next: ConversationState): void {
    try {
      assertConversationTransition(conversation.state, next);
    } catch {
      throw new AttendanceError(
        409,
        "invalid_conversation_state",
        `Transição inválida de ${conversation.state} para ${next}.`
      );
    }
    conversation.state = next;
  }

  private assertOwner(conversation: Conversation, userId: string): void {
    if (conversation.state !== "HUMAN_ACTIVE" || conversation.assignedUserId !== userId) {
      throw new AttendanceError(409, "conversation_not_owned", "A conversa não está atribuída a este atendente.");
    }
  }

  private pushMessage(message: Message): void {
    const conversationMessages = this.messages.get(message.conversationId);
    if (!conversationMessages) throw new Error("Conversa local sem histórico de mensagens.");
    conversationMessages.push(message);
  }

  private appendBotReply(conversation: Conversation, text: string, now: string): void {
    const botMessage: Message = {
      id: this.createId(),
      conversationId: conversation.id,
      role: "BOT",
      text,
      createdAt: now,
      deliveryStatus: "SIMULATED",
      authorName: null
    };
    this.pushMessage(botMessage);
    this.createOutboxEntry(conversation, botMessage);
    conversation.lastMessagePreview = text;
    conversation.updatedAt = now;
    this.notifyOutbound(conversation, botMessage);
  }

  markDelivery(tenantId: string, messageId: string, update: {
    status: "ACCEPTED" | "BLOCKED";
    resultCode: string | null;
    providerMessageId?: string;
  }): void {
    const entry = this.outbox.get(messageId);
    const conversationId = entry?.conversationId ?? [...this.messages.entries()]
      .find(([, items]) => items.some((item) => item.id === messageId))?.[0];
    if (!conversationId) return;
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.tenantId !== tenantId) return;
    this.mutateTenantState(tenantId, () => {
      const message = (this.messages.get(conversationId) ?? []).find((item) => item.id === messageId);
      const current = this.outbox.get(messageId);
      if (!message || message.conversationId !== conversationId) return;
      if (current?.status === "SENDING") return;
      message.deliveryStatus = update.status;
      message.deliveryDetail = update.status === "BLOCKED"
        ? update.resultCode
        : update.resultCode === "delivered" || update.resultCode === "read" ? update.resultCode : null;
      if (!current) return;
      current.status = update.status;
      current.resultCode = update.resultCode;
      current.completedAt = this.now().toISOString();
      current.blockedReason = update.status === "BLOCKED" ? current.blockedReason : null;
      if (update.status === "ACCEPTED") {
        current.attemptCount = 1;
        current.providerMessageId = update.providerMessageId ?? null;
      }
    });
  }

  noteProviderAck(tenantId: string, providerMessageId: string, ack: "delivered" | "read" | "failed", detail?: string): void {
    const entry = [...this.outbox.values()].find((item) => item.tenantId === tenantId && item.providerMessageId === providerMessageId);
    if (!entry) return;
    const rank = (value: string | null | undefined) => value === "read" ? 2 : value === "delivered" ? 1 : 0;
    this.mutateTenantState(tenantId, () => {
      const current = this.outbox.get(entry.id);
      const message = (this.messages.get(entry.conversationId) ?? []).find((item) => item.id === entry.messageId);
      if (!current || !message || message.conversationId !== entry.conversationId) return;
      if (ack === "failed") {
        if (rank(message.deliveryDetail) > 0) return;
        current.status = "BLOCKED";
        current.resultCode = detail || "ack_error";
        current.blockedReason = null;
        message.deliveryStatus = "BLOCKED";
        message.deliveryDetail = current.resultCode;
        return;
      }
      if (rank(ack) <= rank(message.deliveryDetail)) return;
      current.status = "ACCEPTED";
      current.resultCode = ack;
      message.deliveryStatus = "ACCEPTED";
      message.deliveryDetail = ack;
    });
  }

  retryOutbound(tenantId: string, conversationId: string, messageId: string): Message {
    const conversation = this.getConversationRecord(tenantId, conversationId);
    const message = (this.messages.get(conversationId) ?? []).find((item) => item.id === messageId);
    if (!message) throw new AttendanceError(404, "message_not_found", "Mensagem não encontrada.");
    if (!["BLOCKED", "HTTP_ERROR", "INDETERMINATE"].includes(message.deliveryStatus)) {
      throw new AttendanceError(409, "message_not_retryable", "Só uma mensagem que falhou pode ser reenviada.");
    }
    return this.mutateTenantState(tenantId, () => {
      const current = (this.messages.get(conversationId) ?? []).find((item) => item.id === messageId);
      if (!current) throw new AttendanceError(404, "message_not_found", "Mensagem não encontrada.");
      current.deliveryStatus = "PENDING";
      current.deliveryDetail = null;
      const entry = this.outbox.get(messageId);
      if (entry) {
        entry.status = "PENDING";
        entry.resultCode = null;
        entry.blockedReason = null;
        entry.completedAt = null;
        entry.providerMessageId = null;
      }
      this.notifyOutbound(conversation, current);
      return copyMessage(current);
    });
  }

  private notifyCustomer(event: CustomerMessageNotice): void {
    try {
      this.onCustomerMessage?.(event);
    } catch {
      // O canal não pode desfazer o atendimento já decidido.
    }
  }

  private notifyOutbound(conversation: Conversation, message: Message): void {
    if (message.deliveryStatus === "RECEIVED") return;
    try {
      this.onOutboundMessage?.({
        tenantId: conversation.tenantId,
        conversationId: conversation.id,
        messageId: message.id,
        customerPhone: conversation.customerPhone,
        text: message.text,
        role: message.role === "ATTENDANT" ? "ATTENDANT" : "BOT",
        lastInboundAt: conversation.lastInboundAt,
        inboundMessageId: conversation.lastInboundMessageId,
        deliveryStatus: message.deliveryStatus,
        source: conversation.lastInboundSource
      });
    } catch {
      // Falha de entrega fica no canal; o histórico local permanece.
    }
  }

  private llmFailureOutcome(): LlmTurnOutcome {
    try {
      return this.llmAssistant?.failureOutcome() ?? {
        kind: "reply_and_handoff",
        text: "Não consegui responder agora. Vou transferir você para uma pessoa."
      };
    } catch {
      return {
        kind: "reply_and_handoff",
        text: "Não consegui responder agora. Vou transferir você para uma pessoa."
      };
    }
  }
}

