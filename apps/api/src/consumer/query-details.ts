import type { CustomerOrder, OrderLine } from "../ordering/types.js";
import {
  ConsumerPartnerMappingError,
  type ConsumerCatalogMapping
} from "./partner-api.js";

export interface ConsumerQueryDetailsContext {
  displayId: string;
  merchant: { id: string; name: string };
  customer: {
    id: string;
    name: string;
    phone: string;
    phoneLocalizer: string;
    phoneLocalizerExpiration: string;
    ordersCountOnMerchant: number;
    documentNumber?: string | null;
  };
  payments: {
    prepaidCents: number;
    pendingCents: number;
    methods: Array<{
      method: string;
      /** The manual's query-details example uses values such as OFFLINE. */
      type: string;
      prepaid: boolean;
      valueCents: number;
      cardBrand?: string | null;
    }>;
  };
  delivery: {
    mode: string;
    deliveredBy: string;
    pickupCode: string;
    deliveryDateTime: string;
    observations?: string | null;
    address: {
      country: string;
      state: string;
      city: string;
      postalCode: string;
      streetName: string;
      streetNumber: string;
      neighborhood: string;
      complement?: string | null;
      reference?: string | null;
      coordinates?: { latitude: number; longitude: number };
    };
  };
  salesChannel?: string;
  preparationStartDateTime?: string;
}

export interface ConsumerQueryDetailsResponse {
  item: {
    benefits: [];
    orderType: "DELIVERY";
    payments: {
      methods: Array<{
        method: string;
        prepaid: boolean;
        currency: "BRL";
        type: string;
        value: number;
        cash: null;
        card: null | { brand: string };
        wallet: null;
      }>;
      pending: number;
      prepaid: number;
    };
    merchant: { name: string; id: string };
    salesChannel: string;
    picking: null;
    orderTiming: "IMMEDIATE";
    createdAt: string;
    total: {
      benefits: number;
      deliveryFee: number;
      orderAmount: number;
      subTotal: number;
      additionalFees: number;
    };
    preparationStartDateTime: string;
    id: string;
    displayId: string;
    items: Array<{
      unitPrice: number;
      quantity: number;
      externalCode: string;
      totalPrice: number;
      index: number;
      unit: "UN";
      ean: null;
      price: number;
      observations: string;
      imageUrl: null;
      name: string;
      options: null | Array<{
        unitPrice: number;
        unit: "UN";
        ean: null;
        quantity: number;
        externalCode: string;
        price: number;
        name: string;
        index: number;
        id: string;
        addition: number;
      }>;
      id: string;
      uniqueId: string;
      optionsPrice: number;
      addition: number;
      scalePrices: null;
    }>;
    customer: {
      phone: { number: string; localizer: string; localizerExpiration: string };
      documentNumber: string | null;
      name: string;
      ordersCountOnMerchant: number;
      id: string;
    };
    extraInfo: string | null;
    additionalFees: null;
    delivery: {
      mode: string;
      pickupCode: string;
      deliveredBy: string;
      deliveryAddress: {
        reference?: string | null;
        country: string;
        streetName: string;
        formattedAddress: string;
        streetNumber: string;
        city: string;
        postalCode: string;
        coordinates?: { latitude: number; longitude: number };
        neighborhood: string;
        state: string;
        complement?: string | null;
      };
      deliveryDateTime: string;
      observations: string | null;
    };
    schedule: null;
    indoor: null;
    takeout: null;
  };
  statusCode: 0;
  reasonPhrase: null;
}

function text(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ConsumerPartnerMappingError(`Campo obrigatório ausente: ${field}.`);
  return trimmed;
}

function money(cents: number): number {
  return cents / 100;
}

function mapQueryLine(
  line: OrderLine,
  index: number,
  mapping: ConsumerCatalogMapping
): ConsumerQueryDetailsResponse["item"]["items"][number] {
  const externalCode = mapping.productExternalCode(line)?.trim();
  if (!externalCode) throw new ConsumerPartnerMappingError(`Falta código PDV do produto ${line.itemId}.`);
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
    throw new ConsumerPartnerMappingError(`Quantidade inválida no item ${line.lineId}.`);
  }

  const variants = new Set(mapping.productVariantChoiceIdsByItemId?.[line.itemId] ?? []);
  const options = line.choices.filter((choice) => !variants.has(choice.choiceId));
  const optionCodes = options.map((choice) => {
    const optionExternalCode = mapping.optionExternalCodesByChoiceId[choice.choiceId]?.trim();
    if (!optionExternalCode) throw new ConsumerPartnerMappingError(`Falta código PDV da opção ${choice.choiceId}.`);
    return { choice, externalCode: optionExternalCode };
  });
  const optionsPerUnitCents = options.reduce((sum, choice) => sum + choice.priceCents, 0);
  const productUnitPriceCents = line.unitPriceCents - optionsPerUnitCents;
  const productTotalCents = productUnitPriceCents * line.quantity;
  const optionsTotalCents = optionsPerUnitCents * line.quantity;
  if (productUnitPriceCents < 0 || productTotalCents + optionsTotalCents !== line.lineTotalCents) {
    throw new ConsumerPartnerMappingError(`Os valores do item ${line.lineId} não fecham com o total da linha.`);
  }

  return {
    unitPrice: money(productUnitPriceCents),
    quantity: line.quantity,
    externalCode,
    totalPrice: money(line.lineTotalCents),
    index,
    unit: "UN",
    ean: null,
    price: money(productTotalCents),
    observations: "",
    imageUrl: null,
    name: line.name,
    options: optionCodes.length === 0 ? null : optionCodes.map(({ choice, externalCode: optionCode }, optionIndex) => ({
      unitPrice: money(choice.priceCents),
      unit: "UN",
      ean: null,
      quantity: line.quantity,
      externalCode: optionCode,
      price: money(choice.priceCents * line.quantity),
      name: choice.name,
      index: optionIndex,
      id: `${line.lineId}:${choice.choiceId}`,
      addition: 0
    })),
    id: line.lineId,
    uniqueId: line.lineId,
    optionsPrice: money(optionsTotalCents),
    addition: 0,
    scalePrices: null
  };
}

/**
 * Response for Consumer's query-details flow. The documented sample wraps the
 * lowerCamelCase order in `item`, followed by statusCode and reasonPhrase.
 */
export function buildConsumerOrderDetailsResponse(
  order: CustomerOrder,
  context: ConsumerQueryDetailsContext,
  mapping: ConsumerCatalogMapping
): ConsumerQueryDetailsResponse {
  if (order.status !== "confirmed" && order.status !== "sent_to_integration") {
    throw new ConsumerPartnerMappingError("O Consumer só pode consultar pedidos confirmados.");
  }
  if (order.fulfillment?.method !== "delivery") {
    throw new ConsumerPartnerMappingError("O contrato lowerCamelCase documentado cobre pedidos delivery; retirada precisa do formato específico do Consumer.");
  }
  if (order.lines.length === 0) throw new ConsumerPartnerMappingError("Não é possível integrar um pedido sem itens.");
  const linesSubtotalCents = order.lines.reduce((total, line) => total + line.lineTotalCents, 0);
  if (order.deliveryFeeCents < 0 || order.subtotalCents < 0 || order.totalCents < 0 ||
    linesSubtotalCents !== order.subtotalCents || order.subtotalCents + order.deliveryFeeCents !== order.totalCents) {
    throw new ConsumerPartnerMappingError("Os totais do pedido não fecham com os itens e a taxa de entrega.");
  }
  if (context.payments.prepaidCents + context.payments.pendingCents !== order.totalCents) {
    throw new ConsumerPartnerMappingError("O total dos pagamentos não confere com o valor do pedido.");
  }

  const customer = context.customer;
  const delivery = context.delivery;
  const methods = context.payments.methods.map((method) => ({
    method: text(method.method, "payments.methods.method"),
    prepaid: method.prepaid,
    currency: "BRL" as const,
    type: text(method.type, "payments.methods.type"),
    value: money(method.valueCents),
    cash: null,
    card: method.cardBrand ? { brand: method.cardBrand } : null,
    wallet: null
  }));
  const paymentTotalCents = context.payments.methods.reduce((sum, method) => sum + method.valueCents, 0);
  const prepaidMethodsCents = context.payments.methods
    .filter((method) => method.prepaid)
    .reduce((sum, method) => sum + method.valueCents, 0);
  const pendingMethodsCents = context.payments.methods
    .filter((method) => !method.prepaid)
    .reduce((sum, method) => sum + method.valueCents, 0);
  if (paymentTotalCents !== context.payments.prepaidCents + context.payments.pendingCents ||
    prepaidMethodsCents !== context.payments.prepaidCents || pendingMethodsCents !== context.payments.pendingCents) {
    throw new ConsumerPartnerMappingError("A soma dos métodos de pagamento não confere com os valores pré-pago e pendente.");
  }
  const address = delivery.address;
  const formattedAddress = [
    [address.streetName, address.streetNumber].filter(Boolean).join(", "),
    address.complement,
    address.neighborhood,
    [address.city, address.state].filter(Boolean).join(" - "),
    address.postalCode
  ].filter(Boolean).join(", ");

  return {
    item: {
      benefits: [],
      orderType: "DELIVERY",
      payments: {
        methods,
        pending: money(context.payments.pendingCents),
        prepaid: money(context.payments.prepaidCents)
      },
      merchant: {
        name: text(context.merchant.name, "merchant.name"),
        id: text(context.merchant.id, "merchant.id")
      },
      salesChannel: context.salesChannel?.trim() || "PARTNER",
      picking: null,
      orderTiming: "IMMEDIATE",
      createdAt: order.createdAt,
      total: {
        benefits: 0,
        deliveryFee: money(order.deliveryFeeCents),
        orderAmount: money(order.totalCents),
        subTotal: money(order.subtotalCents),
        additionalFees: 0
      },
      preparationStartDateTime: context.preparationStartDateTime ?? order.confirmedAt ?? order.createdAt,
      id: order.id,
      displayId: text(context.displayId, "displayId"),
      items: order.lines.map((line, index) => mapQueryLine(line, index, mapping)),
      customer: {
        phone: {
          number: text(customer.phone, "customer.phone.number"),
          localizer: text(customer.phoneLocalizer, "customer.phone.localizer"),
          localizerExpiration: text(customer.phoneLocalizerExpiration, "customer.phone.localizerExpiration")
        },
        documentNumber: customer.documentNumber ?? null,
        name: text(customer.name, "customer.name"),
        ordersCountOnMerchant: customer.ordersCountOnMerchant,
        id: text(customer.id, "customer.id")
      },
      extraInfo: order.fulfillment.notes || null,
      additionalFees: null,
      delivery: {
        mode: text(delivery.mode, "delivery.mode"),
        pickupCode: text(delivery.pickupCode, "delivery.pickupCode"),
        deliveredBy: text(delivery.deliveredBy, "delivery.deliveredBy"),
        deliveryAddress: {
          reference: address.reference ?? "",
          country: text(address.country, "delivery.deliveryAddress.country"),
          streetName: text(address.streetName, "delivery.deliveryAddress.streetName"),
          formattedAddress,
          streetNumber: text(address.streetNumber, "delivery.deliveryAddress.streetNumber"),
          city: text(address.city, "delivery.deliveryAddress.city"),
          postalCode: text(address.postalCode, "delivery.deliveryAddress.postalCode"),
          ...(address.coordinates ? { coordinates: address.coordinates } : {}),
          neighborhood: text(address.neighborhood, "delivery.deliveryAddress.neighborhood"),
          state: text(address.state, "delivery.deliveryAddress.state"),
          complement: address.complement ?? ""
        },
        deliveryDateTime: text(delivery.deliveryDateTime, "delivery.deliveryDateTime"),
        observations: delivery.observations ?? null
      },
      schedule: null,
      indoor: null,
      takeout: null
    },
    statusCode: 0,
    reasonPhrase: null
  };
}
