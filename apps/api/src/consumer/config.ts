import { z } from "zod";
import type { ConsumerCatalogMapping } from "./partner-api.js";
import type {
  ConsumerPartnerConfigRecord,
  ConsumerProductMapping,
  ConsumerOptionMapping
} from "./repository.js";
import type { OrderLine } from "../ordering/types.js";

const shortText = (max: number) => z.string().trim().min(1).max(max);
const idList = z.array(shortText(160)).max(40).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "A lista contém IDs duplicados." });
});

export const consumerConfigInputSchema = z.object({
  enabled: z.boolean(),
  publicBaseUrl: shortText(500),
  merchantId: shortText(160),
  merchantName: shortText(160),
  salesChannel: z.string().trim().max(80).optional(),
  deliveryFeeReceivedBy: z.enum(["MERCHANT", "PARTNER"]).nullable().optional(),
  productMappings: z.array(z.object({
    itemId: shortText(160),
    choiceIds: idList.default([]),
    externalCode: shortText(160)
  }).strict()).max(2_000),
  optionMappings: z.array(z.object({
    choiceId: shortText(160),
    externalCode: shortText(160)
  }).strict()).max(4_000),
  variantChoiceIdsByItemId: z.record(z.string().trim().min(1).max(160), idList).default({})
}).strict().superRefine((value, context) => {
  let parsed: URL | undefined;
  try { parsed = new URL(value.publicBaseUrl); } catch { /* handled below */ }
  if (!parsed || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    context.addIssue({ code: "custom", path: ["publicBaseUrl"], message: "Informe uma URL HTTP(S) pública sem credenciais, query ou fragmento." });
  } else if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    context.addIssue({ code: "custom", path: ["publicBaseUrl"], message: "Use HTTPS; HTTP só é aceito em loopback para desenvolvimento." });
  }

  const productKeys = value.productMappings.map((mapping) => `${mapping.itemId}\u0000${[...mapping.choiceIds].sort().join("\u0000")}`);
  if (new Set(productKeys).size !== productKeys.length) context.addIssue({ code: "custom", path: ["productMappings"], message: "Há mapeamentos duplicados de produto/variante." });
  const optionIds = value.optionMappings.map((mapping) => mapping.choiceId);
  if (new Set(optionIds).size !== optionIds.length) context.addIssue({ code: "custom", path: ["optionMappings"], message: "Há mapeamentos duplicados de opção." });
  for (const mapping of value.productMappings) {
    const variants = value.variantChoiceIdsByItemId[mapping.itemId] ?? [];
    if (mapping.choiceIds.some((id) => !variants.includes(id))) {
      context.addIssue({ code: "custom", path: ["productMappings"], message: `Os choiceIds de ${mapping.itemId} devem estar declarados como variantes.` });
    }
  }
});

export type ConsumerConfigInput = z.infer<typeof consumerConfigInputSchema>;

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dateText = shortText(100).refine((value) => Number.isFinite(Date.parse(value)), "Informe data/hora válida.");

export const consumerOrderDetailsContextSchema = z.object({
  displayId: shortText(80),
  customer: z.object({
    id: shortText(160),
    name: shortText(160),
    phone: shortText(40),
    phoneLocalizer: shortText(160),
    phoneLocalizerExpiration: dateText,
    ordersCountOnMerchant: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    documentNumber: z.string().trim().max(80).nullable().optional()
  }).strict(),
  payments: z.object({
    prepaidCents: cents,
    pendingCents: cents,
    methods: z.array(z.object({
      method: shortText(80),
      type: shortText(80),
      prepaid: z.boolean(),
      valueCents: cents,
      cardBrand: z.string().trim().max(80).nullable().optional()
    }).strict()).max(20)
  }).strict(),
  delivery: z.object({
    mode: shortText(80),
    deliveredBy: shortText(80),
    pickupCode: shortText(80),
    deliveryDateTime: dateText,
    observations: z.string().trim().max(1_000).nullable().optional(),
    address: z.object({
      country: shortText(80),
      state: shortText(80),
      city: shortText(160),
      postalCode: shortText(40),
      streetName: shortText(200),
      streetNumber: shortText(80),
      neighborhood: shortText(160),
      complement: z.string().trim().max(200).nullable().optional(),
      reference: z.string().trim().max(300).nullable().optional(),
      coordinates: z.object({ latitude: z.number().finite(), longitude: z.number().finite() }).strict().optional()
    }).strict()
  }).strict(),
  salesChannel: z.string().trim().max(80).optional(),
  preparationStartDateTime: dateText.optional()
}).strict();

export type ConsumerOrderDetailsContextInput = z.infer<typeof consumerOrderDetailsContextSchema>;

export interface ConsumerOrderDetailsContext extends ConsumerOrderDetailsContextInput {
  merchant: { id: string; name: string };
}

export function normalizePublicBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

export function toConsumerCatalogMapping(config: Pick<ConsumerPartnerConfigRecord,
  "productMappings" | "optionMappings" | "variantChoiceIdsByItemId">): ConsumerCatalogMapping {
  return {
    productExternalCode: (line: OrderLine) => resolveProductCode(line, config.productMappings, config.variantChoiceIdsByItemId),
    optionExternalCodesByChoiceId: Object.fromEntries(config.optionMappings.map(({ choiceId, externalCode }) => [choiceId, externalCode])),
    productVariantChoiceIdsByItemId: config.variantChoiceIdsByItemId
  };
}

function resolveProductCode(
  line: OrderLine,
  mappings: readonly ConsumerProductMapping[],
  variantChoiceIdsByItemId: Readonly<Record<string, readonly string[]>>
): string | undefined {
  const variantIds = new Set(variantChoiceIdsByItemId[line.itemId] ?? []);
  const selectedVariantIds = line.choices.map(({ choiceId }) => choiceId).filter((id) => variantIds.has(id)).sort();
  const matching = mappings.find((mapping) => mapping.itemId === line.itemId &&
    mapping.choiceIds.length === selectedVariantIds.length &&
    [...mapping.choiceIds].sort().every((id, index) => id === selectedVariantIds[index]));
  return matching?.externalCode;
}

export function publicConsumerConfig(config: ConsumerPartnerConfigRecord) {
  const base = config.publicBaseUrl;
  return {
    enabled: config.enabled,
    publicBaseUrl: base,
    merchantId: config.merchantId,
    merchantName: config.merchantName,
    salesChannel: config.salesChannel,
    deliveryFeeReceivedBy: config.deliveryFeeReceivedBy,
    productMappings: config.productMappings,
    optionMappings: config.optionMappings,
    variantChoiceIdsByItemId: config.variantChoiceIdsByItemId,
    tokenConfigured: true,
    tokenCreatedAt: config.tokenCreatedAt,
    updatedAt: config.updatedAt,
    endpoints: {
      polling: `${base}/api/Polling`,
      orderDetails: `${base}/api/Order/{orderId}`,
      status: `${base}/api/Order`,
      infoOrderDetail: `${base}/api/InfoOrderDetail`
    }
  };
}

export function toPersistedMappings(input: ConsumerConfigInput): {
  productMappings: ConsumerProductMapping[];
  optionMappings: ConsumerOptionMapping[];
  variantChoiceIdsByItemId: Record<string, string[]>;
} {
  return {
    productMappings: input.productMappings.map((mapping) => ({
      itemId: mapping.itemId,
      choiceIds: [...mapping.choiceIds].sort(),
      externalCode: mapping.externalCode
    })),
    optionMappings: input.optionMappings.map((mapping) => ({ ...mapping })),
    variantChoiceIdsByItemId: Object.fromEntries(Object.entries(input.variantChoiceIdsByItemId)
      .map(([itemId, choiceIds]) => [itemId, [...choiceIds].sort()]))
  };
}
