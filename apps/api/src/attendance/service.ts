import { randomUUID } from "node:crypto";
import {
  assertConversationTransition,
  type ConversationState
} from "../domain/conversation-state.js";
import type { InboundMessageType, NormalizedInboundMessage } from "../meta/inbound-message.js";
import type {
  Conversation,
  CreateTenantInput,
  AttendanceSnapshot,
  AttendanceStateRepository,
  KnowledgeEntry,
  LocalOutboundOptions,
  Message,
  OutboxEntry,
  OutboundBlockReason,
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
  outbound?: LocalOutboundOptions;
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

function copyConfig(config: TenantConfig): TenantConfig {
  return {
    ...config,
    assistantMode: config.assistantMode ?? "approved_faq",
    knowledge: config.knowledge.map((entry) => ({ ...entry })),
    handoffKeywords: [...config.handoffKeywords]
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

const humanManagedActionPatterns = [
  /\b(?:quero|gostaria|preciso|pode|poderia|me ajuda a|me ajude a)\b.{0,60}\b(?:pedir|encomendar|comprar|pedido|reserva|reservar|agendar|agendamento|marcar|remarcar|reagendar|cancelar)\b/,
  /\b(?:fazer|faco|montar|colocar|enviar|realizar|confirmar|acompanhar|alterar|cancelar)\s+(?:(?:um|o|meu|minha)\s+)?(?:pedido|encomenda)\b/,
  /\b(?:pedido|encomenda)\b.{0,40}\b(?:entrega|delivery|retirada|retirar|acompanhar|alterar|cancelar)\b/,
  /\b(?:reservar|reserve|agendar|agende|marcar|marque|remarcar|reagendar|cancelar|cancele)\b.{0,60}\b(?:mesa|horario|atendimento|corte|barba)\b/,
  /\b(?:tem|ha|haveria|teria|consegue|pode|poderia)\b.{0,50}\bmesa\b/,
  /\b(?:tem|ha|haveria|teria|consegue|pode|poderia)\b.{0,50}\bhorario\b.{0,35}\b(?:disponivel|livre|vaga|corte|barba|marcar|agendar|reservar|fazer|cortar)\b/,
  /\b(?:horarios? disponiveis|horarios? livres|disponibilidade)\b.{0,50}\b(?:horario|corte|barba|atendimento|mesa|reserva|agendamento)?\b/,
  /\b(?:me encaixa|consegue me encaixar|queria um horario)\b.{0,60}\b(?:corte|barba|atendimento|cabelo|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)?\b/,
  /\b(?:quero|gostaria|preciso|pode|poderia|me ajuda a|me ajude a)\b.{0,60}\b(?:orcamento|cotacao)\b/,
  /\b(?:solicitar|preparar|fazer|faca|fazem|faz|montam|montar|passar|me passar)\s+(?:um\s+)?(?:orcamento|cotacao)\b/
];

function requiresHumanManagedAction(text: string): boolean {
  const normalizedText = normalizeForMatching(text);
  return humanManagedActionPatterns.some((pattern) => pattern.test(normalizedText));
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
  private readonly outbound: LocalOutboundOptions | undefined;
  private readonly outbox = new Map<string, OutboxEntry>();
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
    this.outbound = options.outbound;
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
    return { tenant: copyTenant(record.tenant), config: copyConfig(record.config) };
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
      record.config = {
        businessName: input.businessName,
        segment: input.segment,
        greeting: input.greeting,
        knowledge: input.knowledge.map((entry) => ({ ...entry })),
        handoffKeywords: [...input.handoffKeywords],
        assistantMode: input.assistantMode ?? record.config.assistantMode ?? "approved_faq",
        version: record.config.version + 1
      };
      return { tenant: copyTenant(record.tenant), config: copyConfig(record.config) };
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
      const pending = [...this.outbox.values()].find((entry) => entry.status === "PENDING");
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
    const blockedReason = this.outboundBlockReason(conversation, tenant.channelPhoneNumberId);
    const status: OutboundStatus = !this.outbound?.enabled
      ? "SIMULATED"
      : blockedReason ? "BLOCKED" : "PENDING";
    message.deliveryStatus = status;
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
      resultCode: !this.outbound?.enabled ? "outbound_disabled" : blockedReason,
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
    const initiallyHandled =
      !textMessage ||
      containsHandoffKeyword(text, record.config.handoffKeywords) ||
      requiresHumanManagedAction(text);
    const existingId = this.conversationKeys.get(`${tenantId}:${customerPhone}`);
    const existing = existingId ? this.conversations.get(existingId) : undefined;
    const canUseBot = !existing || existing.state === "BOT_ACTIVE" || existing.state === "CLOSED";
    const exactAnswer = textMessage ? approvedAnswer(text, record.config.knowledge) : undefined;
    const greeting = textMessage && isGreeting(text) ? record.config.greeting : undefined;
    let selectedKnowledge: KnowledgeEntry | undefined;
    if (
      canUseBot && !initiallyHandled && !exactAnswer && !greeting &&
      record.config.assistantMode === "local_ai" && this.knowledgeAnswerSelector && record.config.knowledge.length > 0
    ) {
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
    this.mutateTenantState(tenantId, () => {
      if (this.processedInboundIds.has(dedupeKey)) return;

      const currentRecord = this.getTenantRecord(tenantId);
      const conversationKey = `${tenantId}:${customerPhone}`;
      let conversationId = this.conversationKeys.get(conversationKey);
      let conversation = conversationId ? this.conversations.get(conversationId) : undefined;
      const now = this.now().toISOString();

      if (!conversation) {
        conversationId = this.createId();
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

      if (conversation.state === "BOT_ACTIVE") {
        const shouldHandoff =
          !textMessage ||
          containsHandoffKeyword(text, currentRecord.config.handoffKeywords) ||
          requiresHumanManagedAction(text);
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
          const response = answer ?? (isGreeting(text) ? currentRecord.config.greeting : undefined) ?? safeSelectedAnswer;
          if (response) {
            const botMessage: Message = {
              id: this.createId(),
              conversationId: conversation.id,
              role: "BOT",
              text: response,
              createdAt: now,
              deliveryStatus: "SIMULATED",
              authorName: null
            };
            this.pushMessage(botMessage);
            this.createOutboxEntry(conversation, botMessage);
            conversation.lastMessagePreview = response;
            conversation.updatedAt = now;
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

    this.tenants.clear();
    this.channelTenants.clear();
    this.conversations.clear();
    this.conversationKeys.clear();
    this.messages.clear();
    this.outbox.clear();
    this.processedInboundIds.clear();
    for (const [id, record] of tenants) this.tenants.set(id, record);
    for (const [channelId, tenantId] of channelTenants) this.channelTenants.set(channelId, tenantId);
    for (const [id, conversation] of conversations) this.conversations.set(id, conversation);
    for (const [key, id] of conversationKeys) this.conversationKeys.set(key, id);
    for (const [id, items] of messages) this.messages.set(id, items);
    for (const [id, entry] of outbox) this.outbox.set(id, entry);
    for (const id of processedInboundIds) this.processedInboundIds.add(id);
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
}

