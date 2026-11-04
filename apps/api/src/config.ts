import { z } from "zod";

const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean());

const optionalEnvironmentString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: optionalEnvironmentString,
  META_VERIFY_TOKEN: z.string().min(1).default("development-token"),
  META_APP_SECRET: optionalEnvironmentString,
  META_REQUIRE_SIGNATURE: booleanFromEnvironment.default(true),
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v24.0"),
  ENABLE_LOCAL_DEMO: booleanFromEnvironment.default(false),
  LOCAL_SQLITE_PATH: optionalEnvironmentString,
  LOCAL_AI_ENABLED: booleanFromEnvironment.default(false),
  LOCAL_AI_MODEL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/).optional()
  ),
  WHATSAPP_OUTBOUND_ENABLED: booleanFromEnvironment.default(false),
  WHATSAPP_OUTBOUND_PHONE_NUMBER_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().regex(/^[1-9]\d{0,31}$/).optional()
  ),
  WHATSAPP_OUTBOUND_ACCESS_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional()
  ),
  WHATSAPP_OUTBOUND_ALLOWED_RECIPIENTS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().max(1_000).optional()
  )
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl?: string;
  metaVerifyToken: string;
  metaAppSecret?: string;
  metaRequireSignature: boolean;
  metaGraphApiVersion: string;
  localDemoEnabled?: boolean;
  localSqlitePath?: string;
  localAiEnabled: boolean;
  localAiModel?: string;
  whatsappOutboundEnabled: boolean;
  whatsappOutboundPhoneNumberId?: string;
  whatsappOutboundAccessToken?: string;
  whatsappOutboundAllowedRecipients: string[];
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);

  if (parsed.LOCAL_SQLITE_PATH && (
    !parsed.ENABLE_LOCAL_DEMO || parsed.DATABASE_URL || parsed.NODE_ENV === "production" ||
    !["127.0.0.1", "localhost", "::1"].includes(parsed.API_HOST)
  )) {
    throw new Error("SQLite local exige demonstração explícita, host loopback, ambiente não produtivo e ausência de DATABASE_URL.");
  }

  if (parsed.ENABLE_LOCAL_DEMO && (
    parsed.NODE_ENV === "production" || parsed.DATABASE_URL || !["127.0.0.1", "localhost", "::1"].includes(parsed.API_HOST)
  )) {
    throw new Error("A demonstração local exige ambiente não produtivo, host loopback e armazenamento local sem PostgreSQL.");
  }

  if (parsed.LOCAL_AI_ENABLED && (!parsed.ENABLE_LOCAL_DEMO || !parsed.LOCAL_AI_MODEL)) {
    throw new Error("A IA local exige demonstração local habilitada e LOCAL_AI_MODEL configurado.");
  }

  const allowedRecipients = parsed.WHATSAPP_OUTBOUND_ALLOWED_RECIPIENTS?.split(",") ?? [];
  if (parsed.WHATSAPP_OUTBOUND_ENABLED && parsed.WHATSAPP_OUTBOUND_ACCESS_TOKEN && (
    /\s/.test(parsed.WHATSAPP_OUTBOUND_ACCESS_TOKEN) || parsed.WHATSAPP_OUTBOUND_ACCESS_TOKEN.length > 8_192
  )) {
    throw new Error("WHATSAPP_OUTBOUND_ACCESS_TOKEN tem formato inválido.");
  }
  if (allowedRecipients.some((recipient) => !/^[1-9]\d{7,14}$/.test(recipient)) || new Set(allowedRecipients).size !== allowedRecipients.length) {
    throw new Error("WHATSAPP_OUTBOUND_ALLOWED_RECIPIENTS deve conter telefones E.164 numéricos, separados por vírgula e sem repetição.");
  }
  if (parsed.WHATSAPP_OUTBOUND_ENABLED && (
    !parsed.ENABLE_LOCAL_DEMO || parsed.NODE_ENV === "production" || parsed.DATABASE_URL ||
    !["127.0.0.1", "localhost", "::1"].includes(parsed.API_HOST) ||
    !parsed.LOCAL_SQLITE_PATH ||
    !parsed.WHATSAPP_OUTBOUND_PHONE_NUMBER_ID || !parsed.WHATSAPP_OUTBOUND_ACCESS_TOKEN || allowedRecipients.length === 0
  )) {
    throw new Error("O envio de teste exige demo local em SQLite, loopback, ambiente não produtivo, ID do telefone, token privado e lista explícita de destinatários permitidos.");
  }

  if (parsed.NODE_ENV === "production") {
    if (!parsed.DATABASE_URL) {
      throw new Error("DATABASE_URL é obrigatória em produção.");
    }

    if (!environment.META_VERIFY_TOKEN) {
      throw new Error("META_VERIFY_TOKEN é obrigatório em produção.");
    }

    if (parsed.META_REQUIRE_SIGNATURE && !parsed.META_APP_SECRET) {
      throw new Error("META_APP_SECRET é obrigatório em produção quando a assinatura é exigida.");
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    logLevel: parsed.LOG_LEVEL,
    metaVerifyToken: parsed.META_VERIFY_TOKEN,
    metaRequireSignature: parsed.META_REQUIRE_SIGNATURE,
    metaGraphApiVersion: parsed.META_GRAPH_API_VERSION,
    localDemoEnabled: parsed.ENABLE_LOCAL_DEMO,
    localAiEnabled: parsed.LOCAL_AI_ENABLED,
    whatsappOutboundEnabled: parsed.WHATSAPP_OUTBOUND_ENABLED,
    whatsappOutboundAllowedRecipients: allowedRecipients,
    ...(parsed.LOCAL_AI_MODEL ? { localAiModel: parsed.LOCAL_AI_MODEL } : {}),
    ...(parsed.LOCAL_SQLITE_PATH ? { localSqlitePath: parsed.LOCAL_SQLITE_PATH } : {}),
    ...(parsed.WHATSAPP_OUTBOUND_ENABLED && parsed.WHATSAPP_OUTBOUND_PHONE_NUMBER_ID ? { whatsappOutboundPhoneNumberId: parsed.WHATSAPP_OUTBOUND_PHONE_NUMBER_ID } : {}),
    ...(parsed.WHATSAPP_OUTBOUND_ENABLED && parsed.WHATSAPP_OUTBOUND_ACCESS_TOKEN ? { whatsappOutboundAccessToken: parsed.WHATSAPP_OUTBOUND_ACCESS_TOKEN } : {}),
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
    ...(parsed.META_APP_SECRET ? { metaAppSecret: parsed.META_APP_SECRET } : {})
  };
}

