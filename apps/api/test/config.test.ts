import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("environment configuration", () => {
  it("treats empty optional environment values as unset", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      DATABASE_URL: "",
      META_APP_SECRET: "",
      META_REQUIRE_SIGNATURE: "false"
    });

    expect(config.databaseUrl).toBeUndefined();
    expect(config.metaAppSecret).toBeUndefined();
    expect(config.metaRequireSignature).toBe(false);
  });

  it.each(["typo", "", "enabled"]) (
    "rejects an unrecognized signature setting (%s)",
    (value) => {
      expect(() => loadConfig({ NODE_ENV: "development", META_REQUIRE_SIGNATURE: value })).toThrow();
    }
  );

  it("requires persistent storage in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        META_VERIFY_TOKEN: "production-token",
        META_APP_SECRET: "production-app-secret"
      })
    ).toThrow("DATABASE_URL é obrigatória em produção.");
  });

  it.each([
    { NODE_ENV: "production", API_HOST: "127.0.0.1", ENABLE_LOCAL_DEMO: "true" },
    { NODE_ENV: "development", API_HOST: "0.0.0.0", ENABLE_LOCAL_DEMO: "true" },
    { NODE_ENV: "development", API_HOST: "127.0.0.1", ENABLE_LOCAL_DEMO: "true", DATABASE_URL: "postgresql://local/db" }
  ])("refuses to expose demo accounts outside local memory mode (%j)", (environment) => {
    expect(() => loadConfig(environment)).toThrow("A demonstração local exige");
  });

  it("enables the demo explicitly only on loopback without a database", () => {
    expect(loadConfig({ NODE_ENV: "development", API_HOST: "127.0.0.1", ENABLE_LOCAL_DEMO: "true" }).localDemoEnabled).toBe(true);
    expect(loadConfig({ NODE_ENV: "development", API_HOST: "127.0.0.1" }).localDemoEnabled).toBe(false);
  });

  it("keeps local AI disabled by default and requires the local demo plus a model to enable it", () => {
    expect(loadConfig({ NODE_ENV: "development", API_HOST: "127.0.0.1" }).localAiEnabled).toBe(false);
    const localAi = {
      NODE_ENV: "development",
      API_HOST: "127.0.0.1",
      ENABLE_LOCAL_DEMO: "true",
      LOCAL_AI_ENABLED: "true",
      LOCAL_AI_MODEL: "qwen2.5:1.5b"
    };
    expect(loadConfig(localAi)).toMatchObject({ localAiEnabled: true, localAiModel: "qwen2.5:1.5b" });
    expect(() => loadConfig({ ...localAi, LOCAL_AI_MODEL: "" })).toThrow("LOCAL_AI_MODEL configurado");
    expect(() => loadConfig({ ...localAi, ENABLE_LOCAL_DEMO: "false" })).toThrow("IA local exige demonstração local habilitada");
    expect(() => loadConfig({ ...localAi, API_HOST: "0.0.0.0" })).toThrow("A demonstração local exige");
    expect(() => loadConfig({ ...localAi, LOCAL_AI_MODEL: "model name" })).toThrow();
  });

  it("keeps Cloud API outbound disabled by default and requires a loopback allowlist to opt in", () => {
    expect(loadConfig({ NODE_ENV: "development", API_HOST: "127.0.0.1" })).toMatchObject({
      whatsappOutboundEnabled: false,
      whatsappOutboundAllowedRecipients: []
    });
    expect(loadConfig({
      NODE_ENV: "development", API_HOST: "127.0.0.1", WHATSAPP_OUTBOUND_ACCESS_TOKEN: "unused-private-value"
    }).whatsappOutboundAccessToken).toBeUndefined();

    const outbound = {
      NODE_ENV: "development",
      API_HOST: "127.0.0.1",
      ENABLE_LOCAL_DEMO: "true",
      LOCAL_SQLITE_PATH: "./attendance-test.sqlite",
      WHATSAPP_OUTBOUND_ENABLED: "true",
      WHATSAPP_OUTBOUND_PHONE_NUMBER_ID: "123456789012345",
      WHATSAPP_OUTBOUND_ACCESS_TOKEN: "private-test-token",
      WHATSAPP_OUTBOUND_ALLOWED_RECIPIENTS: "5511999990000"
    };
    expect(loadConfig(outbound)).toMatchObject({
      whatsappOutboundEnabled: true,
      whatsappOutboundPhoneNumberId: "123456789012345",
      whatsappOutboundAllowedRecipients: ["5511999990000"]
    });
    expect(() => loadConfig({ ...outbound, NODE_ENV: "production" })).toThrow();
    expect(() => loadConfig({ ...outbound, API_HOST: "0.0.0.0" })).toThrow();
    expect(() => loadConfig({ ...outbound, ENABLE_LOCAL_DEMO: "false" })).toThrow();
    expect(() => loadConfig({
      NODE_ENV: "development", API_HOST: "127.0.0.1", ENABLE_LOCAL_DEMO: "true",
      WHATSAPP_OUTBOUND_ENABLED: "true", WHATSAPP_OUTBOUND_PHONE_NUMBER_ID: "123456789012345",
      WHATSAPP_OUTBOUND_ACCESS_TOKEN: "private-test-token", WHATSAPP_OUTBOUND_ALLOWED_RECIPIENTS: "5511999990000"
    })).toThrow("demo local em SQLite");
    expect(() => loadConfig({ ...outbound, WHATSAPP_OUTBOUND_ALLOWED_RECIPIENTS: "5511999990000,invalid" })).toThrow("WHATSAPP_OUTBOUND_ALLOWED_RECIPIENTS");
    const invalidPrivateToken = "do-not-print-this\ninvalid";
    try {
      loadConfig({ ...outbound, WHATSAPP_OUTBOUND_ACCESS_TOKEN: invalidPrivateToken });
      throw new Error("Esperava rejeição do token inválido.");
    } catch (error) {
      expect((error as Error).message).toBe("WHATSAPP_OUTBOUND_ACCESS_TOKEN tem formato inválido.");
      expect((error as Error).message).not.toContain(invalidPrivateToken);
    }
  });

  it("accepts explicit SQLite locally and rejects incompatible combinations", () => {
    const environment = { NODE_ENV: "development", API_HOST: "127.0.0.1", ENABLE_LOCAL_DEMO: "true", LOCAL_SQLITE_PATH: "./attendance.sqlite" };
    expect(loadConfig(environment).localSqlitePath).toBe("./attendance.sqlite");
    expect(() => loadConfig({ ...environment, ENABLE_LOCAL_DEMO: "false" })).toThrow("SQLite local exige");
    expect(() => loadConfig({ ...environment, NODE_ENV: "production" })).toThrow("SQLite local exige");
    expect(() => loadConfig({ ...environment, API_HOST: "0.0.0.0" })).toThrow("SQLite local exige");
    expect(() => loadConfig({ ...environment, DATABASE_URL: "postgresql://local/db" })).toThrow("SQLite local exige");
  });
});
