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
  webhookSecret?: string;
  /** Presente só na resposta da API. Não é gravado. */
  webhookSecretConfigured?: boolean;
}

export interface PresentedOrderIntegration {
  webhookUrl?: string;
  webhookSecretConfigured: boolean;
}

export type OrderStatus =
  | "draft"
  | "awaiting_confirmation"
  | "confirmed"
  | "sent_to_integration"
  | "cancelled";

export interface OrderChoice {
  groupId: string;
  choiceId: string;
  name: string;
  priceCents: number;
}

export interface OrderLine {
  lineId: string;
  itemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  choices: OrderChoice[];
  lineTotalCents: number;
}

export interface OrderFulfillment {
  method: "delivery" | "pickup";
  address: string;
  notes: string;
}

export interface CustomerOrder {
  id: string;
  tenantId: string;
  conversationId: string;
  status: OrderStatus;
  lines: OrderLine[];
  fulfillment: OrderFulfillment | null;
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currency: "BRL";
  summaryPresentedAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  integrationReference: string | null;
  integrationError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FallbackItem {
  itemId?: string;
  name?: string;
  quantity?: number;
  choiceIds?: string[];
  choices?: string[];
}

export interface FallbackPlan {
  handoff?: boolean;
  reply?: string;
  confirm?: boolean;
  items?: FallbackItem[];
  fulfillment?: {
    method?: string;
    address?: string;
    notes?: string;
  };
}

export interface ToolResult {
  ok: boolean;
  error?: string;
  message: string;
  changed: boolean;
  handoff: boolean;
}

export const orderStatuses: readonly OrderStatus[] = [
  "draft",
  "awaiting_confirmation",
  "confirmed",
  "sent_to_integration",
  "cancelled"
];
