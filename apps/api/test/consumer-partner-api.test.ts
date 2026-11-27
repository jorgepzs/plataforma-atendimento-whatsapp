import { describe, expect, it } from "vitest";
import {
  buildPartnerOrderDetailsSubmission,
  buildConsumerPollingResponse,
  consumerStatusAck,
  ConsumerPartnerMappingError,
  parseConsumerStatusNotification,
  type ConsumerCatalogMapping,
  type ConsumerPartnerOrderContext
} from "../src/consumer/partner-api.js";
import {
  buildConsumerOrderDetailsResponse,
  type ConsumerQueryDetailsContext
} from "../src/consumer/query-details.js";
import type { CustomerOrder } from "../src/ordering/types.js";

const confirmedOrder: CustomerOrder = {
  id: "order-1",
  tenantId: "tenant-1",
  conversationId: "conversation-1",
  status: "confirmed",
  lines: [{
    lineId: "line-1",
    itemId: "calabresa",
    name: "Pizza Calabresa",
    quantity: 1,
    unitPriceCents: 7100,
    choices: [
      { groupId: "tamanho", choiceId: "grande", name: "Grande", priceCents: 1500 },
      { groupId: "borda", choiceId: "cheddar", name: "Borda cheddar", priceCents: 800 }
    ],
    lineTotalCents: 7100
  }],
  fulfillment: { method: "delivery", address: "Rua A, 10", notes: "Casa azul" },
  subtotalCents: 7100,
  deliveryFeeCents: 800,
  totalCents: 7900,
  currency: "BRL",
  summaryPresentedAt: "2026-11-26T20:00:00.000Z",
  confirmedAt: "2026-11-26T20:01:00.000Z",
  cancelledAt: null,
  integrationReference: null,
  integrationError: null,
  createdAt: "2026-11-26T19:59:00.000Z",
  updatedAt: "2026-11-26T20:01:00.000Z"
};

const context: ConsumerPartnerOrderContext = {
  displayId: "0001",
  merchant: { id: "consumer-merchant-1", name: "Pizzaria Demo" },
  customer: { id: "customer-1", name: "Ana", phone: "+5511999999999", ordersCountOnMerchant: 0 },
  payments: {
    prepaidCents: 0,
    pendingCents: 7900,
    methods: [{ type: "PENDING", method: "PIX", valueCents: 7900 }]
  },
  delivery: {
    deliveredBy: "MERCHANT",
    estimatedDeliveryDateTime: "2026-11-26T20:45:00.000Z",
    address: {
      Country: "BR",
      State: "SP",
      City: "Campinas",
      District: "Centro",
      Street: "Rua A",
      Number: "10",
      Complement: "",
      Reference: "Casa azul",
      FormattedAddress: "Rua A, 10, Centro, Campinas - SP",
      PostalCode: "13000000"
    }
  },
  deliveryFeeReceivedBy: "MERCHANT"
};

const mapping: ConsumerCatalogMapping = {
  productExternalCode: (line) => line.itemId === "calabresa" && line.choices.some((choice) => choice.choiceId === "grande")
    ? "PDV-PIZZA-CAL-G"
    : undefined,
  productVariantChoiceIdsByItemId: { calabresa: ["grande"] },
  optionExternalCodesByChoiceId: { cheddar: "PDV-COMPL-CHEDDAR" }
};

const queryDetailsContext: ConsumerQueryDetailsContext = {
  displayId: "0001",
  merchant: { id: "consumer-merchant-1", name: "Pizzaria Demo" },
  customer: {
    id: "customer-1",
    name: "Ana",
    phone: "+5511999999999",
    phoneLocalizer: "123456",
    phoneLocalizerExpiration: "2026-11-26T21:00:00.000Z",
    ordersCountOnMerchant: 0
  },
  payments: {
    prepaidCents: 0,
    pendingCents: 7900,
    methods: [{ method: "PIX", type: "OFFLINE", prepaid: false, valueCents: 7900 }]
  },
  delivery: {
    mode: "DEFAULT",
    deliveredBy: "Partner",
    pickupCode: "1234",
    deliveryDateTime: "2026-11-26T20:45:00.000Z",
    address: {
      country: "BR",
      state: "SP",
      city: "Campinas",
      postalCode: "13000000",
      streetName: "Rua A",
      streetNumber: "10",
      neighborhood: "Centro",
      complement: "",
      reference: "Casa azul"
    }
  }
};

describe("Consumer Partner API contracts", () => {
  it("exposes a confirmed order as a PLACED polling event", () => {
    expect(buildConsumerPollingResponse(confirmedOrder, "event-1")).toEqual({
      items: [{
        id: "event-1",
        orderId: "order-1",
        createdAt: "2026-11-26T20:01:00.000Z",
        fullCode: "PLACED",
        code: "PLC"
      }],
      statusCode: 0,
      reasonPhrase: null
    });
  });

  it("maps the PascalCase order-details submission contract", () => {
    const payload = buildPartnerOrderDetailsSubmission(confirmedOrder, context, mapping);

    expect(payload).toMatchObject({
      Id: "order-1",
      Type: "DELIVERY",
      DisplayId: "0001",
      LastEvent: "CREATED",
      Merchant: { Id: "consumer-merchant-1", Name: "Pizzaria Demo" },
      Items: [{
        ExternalCode: "PDV-PIZZA-CAL-G",
        UnitPrice: { Value: 63, Currency: "BRL" },
        OptionsPrice: { Value: 8, Currency: "BRL" },
        SubtotalPrice: { Value: 63, Currency: "BRL" },
        TotalPrice: { Value: 71, Currency: "BRL" },
        Options: [{ ExternalCode: "PDV-COMPL-CHEDDAR", TotalPrice: { Value: 8, Currency: "BRL" } }]
      }],
      OtherFees: [{ Type: "DELIVERY_FEE", Price: { Value: 8, Currency: "BRL" } }],
      Total: {
        ItemsPrice: { Value: 71, Currency: "BRL" },
        OtherFees: { Value: 8, Currency: "BRL" },
        OrderAmount: { Value: 79, Currency: "BRL" }
      },
      Payments: { Pending: 79, Prepaid: 0 },
      Customer: { Name: "Ana", Phone: { Number: "+5511999999999" } },
      ExtraInfo: "Casa azul"
    });
    expect(payload).toHaveProperty("Id");
    expect(payload).not.toHaveProperty("id");
  });

  it("multiplies complement quantity and totals by the product quantity", () => {
    const doubledOrder: CustomerOrder = {
      ...confirmedOrder,
      lines: [{ ...confirmedOrder.lines[0]!, quantity: 2, lineTotalCents: 14200 }],
      subtotalCents: 14200,
      totalCents: 15000
    };
    const doubledContext: ConsumerPartnerOrderContext = {
      ...context,
      payments: {
        prepaidCents: 0,
        pendingCents: 15000,
        methods: [{ type: "PENDING", method: "PIX", valueCents: 15000 }]
      }
    };
    const payload = buildPartnerOrderDetailsSubmission(doubledOrder, doubledContext, mapping);
    expect(payload.Items[0]).toMatchObject({
      Quantity: 2,
      OptionsPrice: { Value: 16, Currency: "BRL" },
      Options: [{ Quantity: 2, UnitPrice: { Value: 8, Currency: "BRL" }, TotalPrice: { Value: 16, Currency: "BRL" } }]
    });
  });

  it("maps the Consumer-queried details as a lowerCamelCase item envelope", () => {
    const payload = buildConsumerOrderDetailsResponse(confirmedOrder, queryDetailsContext, mapping);

    expect(payload).toMatchObject({
      item: {
        id: "order-1",
        displayId: "0001",
        orderType: "DELIVERY",
        orderTiming: "IMMEDIATE",
        payments: { pending: 79, prepaid: 0, methods: [{ method: "PIX", type: "OFFLINE", value: 79 }] },
        merchant: { id: "consumer-merchant-1", name: "Pizzaria Demo" },
        total: { deliveryFee: 8, subTotal: 71, orderAmount: 79 },
        items: [{
          externalCode: "PDV-PIZZA-CAL-G",
          unitPrice: 63,
          totalPrice: 71,
          optionsPrice: 8,
          options: [{ externalCode: "PDV-COMPL-CHEDDAR", quantity: 1, price: 8 }]
        }],
        customer: { phone: { number: "+5511999999999", localizer: "123456" } },
        delivery: {
          mode: "DEFAULT",
          deliveredBy: "Partner",
          deliveryAddress: { streetName: "Rua A", streetNumber: "10", postalCode: "13000000" }
        }
      },
      statusCode: 0,
      reasonPhrase: null
    });
    expect(payload.item).not.toHaveProperty("Id");
    expect(payload).not.toHaveProperty("Items");
  });

  it("multiplies lowerCamelCase complement quantity and price by the product quantity", () => {
    const doubledOrder: CustomerOrder = {
      ...confirmedOrder,
      lines: [{ ...confirmedOrder.lines[0]!, quantity: 2, lineTotalCents: 14200 }],
      subtotalCents: 14200,
      totalCents: 15000
    };
    const doubledContext: ConsumerQueryDetailsContext = {
      ...queryDetailsContext,
      payments: {
        prepaidCents: 0,
        pendingCents: 15000,
        methods: [{ method: "PIX", type: "OFFLINE", prepaid: false, valueCents: 15000 }]
      }
    };
    const payload = buildConsumerOrderDetailsResponse(doubledOrder, doubledContext, mapping);
    expect(payload.item.items[0]).toMatchObject({
      quantity: 2,
      totalPrice: 142,
      optionsPrice: 16,
      options: [{ quantity: 2, unitPrice: 8, price: 16 }]
    });
  });

  it("does not publish an unconfirmed order or invent missing Consumer PDV codes", () => {
    expect(() => buildConsumerPollingResponse({ ...confirmedOrder, status: "awaiting_confirmation" }, "event-2"))
      .toThrow(ConsumerPartnerMappingError);
    expect(() => buildPartnerOrderDetailsSubmission(confirmedOrder, context, {
      ...mapping,
      optionExternalCodesByChoiceId: {}
    })).toThrow("Falta código PDV da opção cheddar.");
  });

  it("requires structured delivery address and payment values that reconcile", () => {
    const { delivery: _delivery, ...contextWithoutDelivery } = context;
    expect(() => buildPartnerOrderDetailsSubmission(confirmedOrder, contextWithoutDelivery, mapping))
      .toThrow("Faltam endereço estruturado e previsão para entrega.");
    expect(() => buildPartnerOrderDetailsSubmission(confirmedOrder, {
      ...context,
      payments: { ...context.payments, pendingCents: 0 }
    }, mapping)).toThrow("O total dos pagamentos não confere");
    expect(() => buildPartnerOrderDetailsSubmission(confirmedOrder, {
      ...context,
      payments: {
        prepaidCents: 7900,
        pendingCents: 0,
        methods: [{ type: "PENDING", method: "PIX", valueCents: 7900 }]
      }
    }, mapping)).toThrow("Os tipos dos métodos de pagamento não conferem");
    const { deliveryFeeReceivedBy: _receiver, ...contextWithoutReceiver } = context;
    expect(() => buildPartnerOrderDetailsSubmission(confirmedOrder, contextWithoutReceiver, mapping))
      .toThrow("Informe quem recebe a taxa de entrega");
  });

  it("validates status callbacks but preserves unknown Consumer enum values", () => {
    expect(parseConsumerStatusNotification({
      orderId: " order-1 ",
      status: "CONCLUDED",
      justification: " finalizado "
    })).toEqual({ orderId: "order-1", status: "CONCLUDED", justification: "finalizado" });
    expect(consumerStatusAck()).toEqual({ statusCode: 0, reasonPhrase: null });
    expect(() => parseConsumerStatusNotification({ orderId: "order-1" })).toThrow("precisa conter status");
  });
});
