import type {
  LocalMembership as AuthLocalMembership,
  LocalRole,
  LocalSession,
  LocalSessionManager,
  LocalUser
} from "../auth/local-sessions.js";
import type { InboundSource, NormalizedInboundMessage } from "../meta/inbound-message.js";
import type { OutboundTextSender } from "../ports/outbound-text-sender.js";

export type { LocalRole, LocalSession, LocalSessionManager, LocalUser } from "../auth/local-sessions.js";

export type TenantSegment = "pizzaria" | "barbearia" | "outro";
export type AssistantMode = "approved_faq" | "local_ai";
export type LocalMembership = AuthLocalMembership;
export type LocalMembershipRole = LocalRole;
export type LocalSessionUser = LocalUser;

export interface PendingInboundEventStore {
  enqueue(message: NormalizedInboundMessage): Promise<"ENQUEUED" | "DUPLICATE" | "UNKNOWN_CHANNEL">;
  takePending(): NormalizedInboundMessage | undefined | Promise<NormalizedInboundMessage | undefined>;
  requeue(message: NormalizedInboundMessage): void | Promise<void>;
  acknowledge?(message: NormalizedInboundMessage): void | Promise<void>;
}

export interface Tenant {
  id: string;
  slug: string;
  displayName: string;
  segment: TenantSegment;
  channelPhoneNumberId: string;
}

export interface KnowledgeEntry {
  question: string;
  answer: string;
}

export interface TenantConfig {
  businessName: string;
  segment: TenantSegment;
  greeting: string;
  knowledge: KnowledgeEntry[];
  handoffKeywords: string[];
  assistantMode: AssistantMode;
  version: number;
}

export interface Conversation {
  id: string;
  tenantId: string;
  customerName: string;
  customerPhone: string;
  state: "BOT_ACTIVE" | "WAITING_HUMAN" | "HUMAN_ACTIVE" | "CLOSED";
  assignedUserId: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string;
  waitingSince: string | null;
  lastInboundMessageId: string | null;
  lastInboundSource: InboundSource | null;
  lastInboundPhoneNumberId: string | null;
  lastInboundAt: string | null;
}

export type OutboundStatus = "SIMULATED" | "PENDING" | "SENDING" | "ACCEPTED" | "BLOCKED" | "HTTP_ERROR" | "INDETERMINATE";
export type OutboundBlockReason = "source_not_meta" | "missing_inbound_context" | "channel_mismatch" | "invalid_recipient" | "recipient_not_allowlisted" | "invalid_inbound_timestamp" | "future_inbound_timestamp" | "service_window_expired" | "test_send_limit_reached";

/** Durable, body-free record of an outbound response attempt/intent. */
export interface OutboxEntry {
  id: string;
  tenantId: string;
  conversationId: string;
  messageId: string;
  sourceInboundMessageId: string | null;
  source: InboundSource | null;
  phoneNumberId: string | null;
  lastInboundAt: string | null;
  status: OutboundStatus;
  blockedReason: OutboundBlockReason | null;
  attemptCount: number;
  providerMessageId: string | null;
  resultCode: string | null;
  createdAt: string;
  attemptedAt: string | null;
  completedAt: string | null;
}

export interface LocalOutboundOptions {
  enabled: boolean;
  phoneNumberId?: string;
  accessToken?: string;
  allowedRecipients: readonly string[];
  graphApiVersion: string;
  /** Durable cap for external attempts, used to constrain the first local Meta test. */
  maxTotalAttempts?: number;
  sender?: OutboundTextSender;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "CUSTOMER" | "BOT" | "ATTENDANT";
  text: string;
  createdAt: string;
  deliveryStatus: "RECEIVED" | OutboundStatus;
  authorName: string | null;
}

export interface AttendanceSnapshot {
  tenants: Array<{ tenant: Tenant; config: TenantConfig }>;
  conversations: Conversation[];
  messages: Message[];
  outbox: OutboxEntry[];
  processedInboundIds: string[];
}

export interface AttendanceStateRepository {
  load(): AttendanceSnapshot | undefined;
  save(snapshot: AttendanceSnapshot): void;
}

export interface CreateTenantInput {
  displayName: string;
  segment: TenantSegment;
}

export interface UpdateTenantConfigInput {
  businessName: string;
  segment: TenantSegment;
  greeting: string;
  knowledge: KnowledgeEntry[];
  handoffKeywords: string[];
  assistantMode?: AssistantMode | undefined;
  version: number;
}

export interface SimulateMessageInput {
  customerName: string;
  customerPhone: string;
  text: string;
  clientMessageId?: string | undefined;
}

export interface SimulateMessageResult {
  eventId: string;
  status: "PENDING" | "DUPLICATE";
}

