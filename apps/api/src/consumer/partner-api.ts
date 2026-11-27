import type { CustomerOrder, OrderChoice, OrderLine } from "../ordering/types.js";

/**
 * Consumer's Partner API is polled by Consumer. This module contains the
 * documented event payload and the separate PascalCase order-submission DTO.
 */
export interface ConsumerPartnerEvent {
  id: string;
  orderId: string;
  createdAt: string;
  fullCode: "PLACED";
  code: "PLC";
}

export interface ConsumerMoney {
  Value: number;
  Currency: "BRL";
}

export interface ConsumerPaymentMethod {
  Value: number;
  Currency: "BRL";
  Type: "PREPAID" | "PENDING";
  Method: ConsumerPaymentMethodCode;
  Brand?: ConsumerPaymentBrandCode;
  MethodInfo?: string;
  ChangeFor?: number;
}

export type ConsumerPaymentMethodCode =
  | "CREDIT" | "DEBIT" | "MEAL_VOUCHER" | "FOOD_VOUCHER" | "DIGITAL_WALLET" | "PIX"
  | "CASH" | "CREDIT_DEBIT" | "COUPON" | "REDEEM" | "PREPAID_REDEEM" | "OTHER";

export type ConsumerPaymentBrandCode =
  | "VISA" | "MASTERCARD" | "DINERS" | "AMEX" | "HIPERCARD" | "ELO" | "AURA" | "DISCOVER"
  | "VR_BENEFICIOS" | "SODEXO" | "TICKET" | "GOOD_CARD" | "BANESCARD" | "SOROCARD" | "POLICARD"
  | "VALECARD" | "AGICARD" | "JCB" | "CREDSYSTEM" | "CABAL" | "GREEN_CARD" | "VEROCHEQUE" | "AVISTA" | "OTHER";

export interface ConsumerDeliveryAddress {
  Country: string;
  State: string;
  City: string;
  District: string;
  Street: string;
  Number: string;
  Complement: string;
  Reference: string;
  FormattedAddress: string;
  PostalCode: string;
}

export interface ConsumerPartnerOrderContext {
  displayId: string;
  merchant: { id: string; name: string };
  customer: {
    id: string;
    name: string;
    phone: string;
    ordersCountOnMerchant: number;
  };
  payments: {
    prepaidCents: number;
    pendingCents: number;
    methods: Array<{
      type: "PREPAID" | "PENDING";
      method: ConsumerPaymentMethodCode;
      valueCents: number;
      brand?: ConsumerPaymentBrandCode;
      methodInfo?: string;
      changeForCents?: number;
    }>;
  };
  /** Required only for delivery; the order model stores an unstructured address. */
  delivery?: {
    deliveredBy: "MERCHANT" | "PARTNER";
    estimatedDeliveryDateTime: string;
    address: ConsumerDeliveryAddress;
  };
  /** Obrigatório quando existe taxa de entrega, pois o Consumer aceita merchant ou partner. */
  deliveryFeeReceivedBy?: "MERCHANT" | "PARTNER";
  /** Optional fields provided by the partner application configuration. */
  sourceAppId?: string;
  salesChannel?: string;
  virtualBrand?: string;
  preparationStartDateTime?: string;
  takeout?: Record<string, unknown> | null;
}

export interface ConsumerCatalogMapping {
  /** Resolve the PDV product code, including any product variant represented as an order choice. */
  productExternalCode(line: OrderLine): string | undefined;
  /** Choices not listed here must be represented by the product's externalCode. */
  optionExternalCodesByChoiceId: Readonly<Record<string, string>>;
  /** Product variant choices affect the SKU code and are not sent as complements. */
  productVariantChoiceIdsByItemId?: Readonly<Record<string, readonly string[]>>;
}

/** PascalCase order payload for the partner-to-Consumer details submission flow. */
export interface PartnerOrderDetailsSubmission {
  Id: string;
  Type: "DELIVERY" | "TAKEOUT";
  DisplayId: string;
  SourceAppId?: string;
  SalesChannel: string;
  VirtualBrand?: string;
  CreatedAt: string;
  LastEvent: "CREATED";
  OrderTiming: "INSTANT";
  PreparationStartDateTime: string;
  Merchant: { Id: string; Name: string };
  Items: Array<{
    Id: string;
    Index: number;
    Name: string;
    ExternalCode: string;
    Unit: "UN";
    Ean: null;
    Quantity: number;
    UnitPrice: ConsumerMoney;
    OriginalPrice: null;
    ScalePriceApplied: false;
    OptionsPrice: ConsumerMoney;
    SubtotalPrice: ConsumerMoney;
    TotalPrice: ConsumerMoney;
    SpecialInstructions: string;
    Indoor: null;
    Options: Array<{
      Id: string;
      Index: number;
      Name: string;
      ExternalCode: string;
      Unit: "UN";
      Ean: null;
      Quantity: number;
      UnitPrice: ConsumerMoney;
      OriginalPrice: null;
      SubtotalPrice: ConsumerMoney;
      TotalPrice: ConsumerMoney;
      SpecialInstructions: string;
      ConsumerItemInfo: null;
    }>;
    ConsumerItemInfo: null;
  }>;
  OtherFees: Array<{
    Name: "TaxaEntrega";
    Type: "DELIVERY_FEE";
    ReceivedBy: "MERCHANT" | "PARTNER";
    ReceiverDocument: null;
    Price: ConsumerMoney;
    Observation: string | null;
  }>;
  Discounts: [];
  Total: {
    ItemsPrice: ConsumerMoney;
    OtherFees: ConsumerMoney;
    Discount: ConsumerMoney;
    OrderAmount: ConsumerMoney;
  };
  Payments: {
    Prepaid: number;
    Pending: number;
    Methods: ConsumerPaymentMethod[];
  };
  Customer: {
    Id: string;
    Name: string;
    DocumentNumber: null;
    Phone: { Number: string; Extension: null };
    Email: null;
    OrdersCountOnMerchant: number;
  };
  Schedule: null;
  OrderPriority: "PRIORITY1";
  Delivery: null | {
    DeliveredBy: "MERCHANT" | "PARTNER";
    DeliveryAddress: ConsumerDeliveryAddress;
    EstimatedDeliveryDateTime: string;
    DeliveryDateTime: null;
    PickupCode: null;
  };
  Takeout: Record<string, unknown> | null;
  Indoor: null;
  SendPreparing: false;
  SendDelivered: false;
  SendPickedUp: false;
  SendTracking: false;
  ExtraInfo: string;
}

export interface ConsumerStatusNotification {
  orderId: string;
  /** Kept opaque because the manual lists meanings but not the exact enum for every status. */
  status: string;
  justification?: string;
}

/** Minimal, direction-specific validation for Consumer's PascalCase POST to the partner. */
export interface ConsumerSubmittedOrderDetails {
  Id: string;
}

export class ConsumerPartnerMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsumerPartnerMappingError";
  }
}

function money(cents: number): ConsumerMoney {
  return { Value: cents / 100, Currency: "BRL" };
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ConsumerPartnerMappingError(`Campo obrigatório ausente: ${field}.`);
  return trimmed;
}

function optionTotalCents(choices: readonly OrderChoice[]): number {
  return choices.reduce((total, choice) => total + choice.priceCents, 0);
}

function mapPaymentMethods(context: ConsumerPartnerOrderContext): ConsumerPaymentMethod[] {
  const paymentMethodCodes = new Set<ConsumerPaymentMethodCode>([
    "CREDIT", "DEBIT", "MEAL_VOUCHER", "FOOD_VOUCHER", "DIGITAL_WALLET", "PIX", "CASH",
    "CREDIT_DEBIT", "COUPON", "REDEEM", "PREPAID_REDEEM", "OTHER"
  ]);
  const paymentBrandCodes = new Set<ConsumerPaymentBrandCode>([
    "VISA", "MASTERCARD", "DINERS", "AMEX", "HIPERCARD", "ELO", "AURA", "DISCOVER",
    "VR_BENEFICIOS", "SODEXO", "TICKET", "GOOD_CARD", "BANESCARD", "SOROCARD", "POLICARD",
    "VALECARD", "AGICARD", "JCB", "CREDSYSTEM", "CABAL", "GREEN_CARD", "VEROCHEQUE", "AVISTA", "OTHER"
  ]);
  for (const method of context.payments.methods) {
    if (!paymentMethodCodes.has(method.method)) {
      throw new ConsumerPartnerMappingError(`Método de pagamento Consumer inválido: ${method.method}.`);
    }
    if (method.brand && !paymentBrandCodes.has(method.brand)) {
      throw new ConsumerPartnerMappingError(`Bandeira de pagamento Consumer inválida: ${method.brand}.`);
    }
  }
  const methods = context.payments.methods.map((method) => ({
    Value: method.valueCents / 100,
    Currency: "BRL" as const,
    Type: method.type,
    Method: method.method,
    ...(method.brand ? { Brand: method.brand } : {}),
    ...(method.methodInfo ? { MethodInfo: method.methodInfo } : {}),
    ...(method.changeForCents === undefined ? {} : { ChangeFor: method.changeForCents / 100 })
  }));
  const prepaidCents = context.payments.methods
    .filter((method) => method.type === "PREPAID")
    .reduce((total, method) => total + method.valueCents, 0);
  const pendingCents = context.payments.methods
    .filter((method) => method.type === "PENDING")
    .reduce((total, method) => total + method.valueCents, 0);
  if (prepaidCents !== context.payments.prepaidCents || pendingCents !== context.payments.pendingCents) {
    throw new ConsumerPartnerMappingError("Os tipos dos métodos de pagamento não conferem com os valores pré-pago e pendente.");
  }
  return methods;
}

function mapOrderLine(
  line: OrderLine,
  index: number,
  mapping: ConsumerCatalogMapping
): PartnerOrderDetailsSubmission["Items"][number] {
  const externalCode = mapping.productExternalCode(line)?.trim();
  if (!externalCode) throw new ConsumerPartnerMappingError(`Falta código PDV do produto ${line.itemId}.`);
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
    throw new ConsumerPartnerMappingError(`Quantidade inválida no item ${line.lineId}.`);
  }

  const variantChoiceIds = new Set(mapping.productVariantChoiceIdsByItemId?.[line.itemId] ?? []);
  const options = line.choices.filter((choice) => !variantChoiceIds.has(choice.choiceId));
  const optionCodes = options.map((choice) => {
    const optionExternalCode = mapping.optionExternalCodesByChoiceId[choice.choiceId]?.trim();
    if (!optionExternalCode) throw new ConsumerPartnerMappingError(`Falta código PDV da opção ${choice.choiceId}.`);
    return { choice, externalCode: optionExternalCode };
  });
  const optionUnitTotal = optionTotalCents(options);
  const productUnitPrice = line.unitPriceCents - optionUnitTotal;
  if (productUnitPrice < 0 || productUnitPrice * line.quantity + optionUnitTotal * line.quantity !== line.lineTotalCents) {
    throw new ConsumerPartnerMappingError(`Os valores do item ${line.lineId} não fecham com o total da linha.`);
  }

  return {
    Id: line.lineId,
    Index: index,
    Name: line.name,
    ExternalCode: externalCode,
    Unit: "UN",
    Ean: null,
    Quantity: line.quantity,
    UnitPrice: money(productUnitPrice),
    OriginalPrice: null,
    ScalePriceApplied: false,
    OptionsPrice: money(optionUnitTotal * line.quantity),
    SubtotalPrice: money(productUnitPrice * line.quantity),
    TotalPrice: money(line.lineTotalCents),
    SpecialInstructions: "",
    Indoor: null,
    Options: optionCodes.map(({ choice, externalCode: optionCode }, optionIndex) => ({
      Id: `${line.lineId}:${choice.choiceId}`,
      Index: optionIndex,
      Name: choice.name,
      ExternalCode: optionCode,
      Unit: "UN",
      Ean: null,
      Quantity: line.quantity,
      UnitPrice: money(choice.priceCents),
      OriginalPrice: null,
      SubtotalPrice: money(choice.priceCents * line.quantity),
      TotalPrice: money(choice.priceCents * line.quantity),
      SpecialInstructions: "",
      ConsumerItemInfo: null
    })),
    ConsumerItemInfo: null
  };
}

/**
 * Creates the polling response for a confirmed order. Consumer then requests
 * the complete order details using the orderId from this event.
 */
export function buildConsumerPollingResponse(
  order: CustomerOrder,
  eventId: string
): { items: ConsumerPartnerEvent[]; statusCode: 0; reasonPhrase: null } {
  if (order.status !== "confirmed" && order.status !== "sent_to_integration") {
    throw new ConsumerPartnerMappingError("Só pedidos confirmados podem entrar na fila do Consumer.");
  }
  const createdAt = order.confirmedAt ?? order.updatedAt;
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new ConsumerPartnerMappingError("Data de confirmação inválida para o evento Consumer.");
  }
  return {
    items: [{
      id: requireText(eventId, "eventId"),
      orderId: order.id,
      createdAt,
      fullCode: "PLACED",
      code: "PLC"
    }],
    statusCode: 0,
    reasonPhrase: null
  };
}

/** Maps an internal order to the separate PascalCase partner submission payload. */
export function buildPartnerOrderDetailsSubmission(
  order: CustomerOrder,
  context: ConsumerPartnerOrderContext,
  mapping: ConsumerCatalogMapping
): PartnerOrderDetailsSubmission {
  if (order.status !== "confirmed" && order.status !== "sent_to_integration") {
    throw new ConsumerPartnerMappingError("Só pedidos confirmados podem ser enviados ao Consumer.");
  }
  if (!order.fulfillment) throw new ConsumerPartnerMappingError("Defina entrega ou retirada antes de integrar o pedido.");
  if (order.fulfillment.method === "delivery" && !context.delivery) {
    throw new ConsumerPartnerMappingError("Faltam endereço estruturado e previsão para entrega.");
  }
  if (order.lines.length === 0) throw new ConsumerPartnerMappingError("Não é possível integrar um pedido sem itens.");
  if (order.deliveryFeeCents < 0 || order.subtotalCents < 0 || order.totalCents < 0) {
    throw new ConsumerPartnerMappingError("Os valores do pedido não podem ser negativos.");
  }
  const linesSubtotalCents = order.lines.reduce((total, line) => total + line.lineTotalCents, 0);
  if (linesSubtotalCents !== order.subtotalCents || order.subtotalCents + order.deliveryFeeCents !== order.totalCents) {
    throw new ConsumerPartnerMappingError("Os totais do pedido não fecham com os itens e a taxa de entrega.");
  }
  if (context.payments.prepaidCents + context.payments.pendingCents !== order.totalCents) {
    throw new ConsumerPartnerMappingError("O total dos pagamentos não confere com o valor do pedido.");
  }
  if (order.deliveryFeeCents > 0 && !context.deliveryFeeReceivedBy) {
    throw new ConsumerPartnerMappingError("Informe quem recebe a taxa de entrega: MERCHANT ou PARTNER.");
  }

  const payments = mapPaymentMethods(context);
  const deliveryFee = order.deliveryFeeCents;
  const otherFees = deliveryFee > 0 ? [{
    Name: "TaxaEntrega" as const,
    Type: "DELIVERY_FEE" as const,
    ReceivedBy: context.deliveryFeeReceivedBy!,
    ReceiverDocument: null,
    Price: money(deliveryFee),
    Observation: null
  }] : [];

  return {
    Id: order.id,
    Type: order.fulfillment.method === "delivery" ? "DELIVERY" : "TAKEOUT",
    DisplayId: requireText(context.displayId, "displayId"),
    ...(context.sourceAppId ? { SourceAppId: context.sourceAppId } : {}),
    SalesChannel: context.salesChannel?.trim() || "PARTNER",
    ...(context.virtualBrand ? { VirtualBrand: context.virtualBrand } : {}),
    CreatedAt: order.createdAt,
    LastEvent: "CREATED",
    OrderTiming: "INSTANT",
    PreparationStartDateTime: context.preparationStartDateTime ?? order.confirmedAt ?? order.createdAt,
    Merchant: {
      Id: requireText(context.merchant.id, "merchant.id"),
      Name: requireText(context.merchant.name, "merchant.name")
    },
    Items: order.lines.map((line, index) => mapOrderLine(line, index, mapping)),
    OtherFees: otherFees,
    Discounts: [],
    Total: {
      ItemsPrice: money(order.subtotalCents),
      OtherFees: money(deliveryFee),
      Discount: money(0),
      OrderAmount: money(order.totalCents)
    },
    Payments: {
      Prepaid: context.payments.prepaidCents / 100,
      Pending: context.payments.pendingCents / 100,
      Methods: payments
    },
    Customer: {
      Id: requireText(context.customer.id, "customer.id"),
      Name: requireText(context.customer.name, "customer.name"),
      DocumentNumber: null,
      Phone: { Number: requireText(context.customer.phone, "customer.phone"), Extension: null },
      Email: null,
      OrdersCountOnMerchant: context.customer.ordersCountOnMerchant
    },
    Schedule: null,
    OrderPriority: "PRIORITY1",
    Delivery: context.delivery ? {
      DeliveredBy: context.delivery.deliveredBy,
      DeliveryAddress: context.delivery.address,
      EstimatedDeliveryDateTime: context.delivery.estimatedDeliveryDateTime,
      DeliveryDateTime: null,
      PickupCode: null
    } : null,
    Takeout: context.takeout ?? null,
    Indoor: null,
    SendPreparing: false,
    SendDelivered: false,
    SendPickedUp: false,
    SendTracking: false,
    ExtraInfo: order.fulfillment.notes
  };
}

/** Validates and preserves Consumer's status notification without guessing undocumented status codes. */
export function parseConsumerStatusNotification(value: unknown): ConsumerStatusNotification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConsumerPartnerMappingError("Notificação de status Consumer inválida.");
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.orderId !== "string" || !payload.orderId.trim()) {
    throw new ConsumerPartnerMappingError("A notificação precisa conter orderId.");
  }
  if (typeof payload.status !== "string" || !payload.status.trim()) {
    throw new ConsumerPartnerMappingError("A notificação precisa conter status.");
  }
  if (payload.justification !== undefined && payload.justification !== null && typeof payload.justification !== "string") {
    throw new ConsumerPartnerMappingError("justification precisa ser texto.");
  }
  return {
    orderId: payload.orderId.trim(),
    status: payload.status.trim(),
    ...(typeof payload.justification === "string" ? { justification: payload.justification.trim() } : {})
  };
}

/** Reads only the documented PascalCase identifier; the remaining Open Delivery DTO is not re-applied to the local order. */
export function parseConsumerSubmittedOrderDetails(value: unknown): ConsumerSubmittedOrderDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConsumerPartnerMappingError("Order Detail incorreto.");
  }
  const id = (value as Record<string, unknown>).Id;
  if (typeof id !== "string" || !id.trim() || id.length > 160) {
    throw new ConsumerPartnerMappingError("Order Detail precisa conter Id PascalCase válido.");
  }
  return { Id: id.trim() };
}

export function consumerStatusAck(reasonPhrase: string | null = null): { statusCode: 0; reasonPhrase: string | null } {
  return { statusCode: 0, reasonPhrase };
}
