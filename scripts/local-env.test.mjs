import assert from "node:assert/strict";
import test from "node:test";
import { assertLocalPostgresUrl, selectDocumentedEnvironment, selectLocalStorageMode } from "./local-env.mjs";
import { installPlan } from "./install-all.mjs";

test("keeps WhatsApp, LLM and local AI settings from the env file", () => {
  const selected = selectDocumentedEnvironment({
    WHATSAPP_CHANNEL_ENABLED: "true",
    WHATSAPP_TEST_UNLIMITED: "true",
    WHATSAPP_PROVIDER: "unofficial_qr",
    LLM_MODEL: "qwen2.5:1.5b",
    LOCAL_AI_ENABLED: "false",
    PATH: "/usr/bin",
    npm_config_cache: "/tmp"
  });
  assert.equal(selected.WHATSAPP_CHANNEL_ENABLED, "true");
  assert.equal(selected.WHATSAPP_TEST_UNLIMITED, "true");
  assert.equal(selected.WHATSAPP_PROVIDER, "unofficial_qr");
  assert.equal(selected.LLM_MODEL, "qwen2.5:1.5b");
  assert.equal(selected.LOCAL_AI_ENABLED, "false");
  assert.equal(selected.PATH, undefined);
  assert.equal(selected.npm_config_cache, undefined);
});

test("keeps the standard launcher on SQLite and selects explicit smoke modes", () => {
  assert.deepEqual(selectLocalStorageMode([]), { useMemory: false, useSqlite: true, usePostgres: false });
  assert.deepEqual(selectLocalStorageMode(["--sqlite"]), { useMemory: false, useSqlite: true, usePostgres: false });
  assert.deepEqual(selectLocalStorageMode(["--postgres"]), { useMemory: false, useSqlite: false, usePostgres: true });
  assert.deepEqual(selectLocalStorageMode(["--smoke"]), { useMemory: true, useSqlite: false, usePostgres: false });
  assert.deepEqual(selectLocalStorageMode(["--sqlite", "--smoke"]), { useMemory: false, useSqlite: true, usePostgres: false });
  assert.deepEqual(selectLocalStorageMode(["--postgres", "--smoke"]), { useMemory: false, useSqlite: false, usePostgres: true });
  assert.throws(() => selectLocalStorageMode(["--memory", "--sqlite"]), /Escolha um único modo/);
  assert.throws(() => selectLocalStorageMode(["--postgres", "--sqlite"]), /Escolha um único modo/);
});

test("allows only local PostgreSQL URLs in development launchers", () => {
  assert.equal(assertLocalPostgresUrl("postgresql://user:pass@127.0.0.1:5432/app"), "postgresql://user:pass@127.0.0.1:5432/app");
  assert.equal(assertLocalPostgresUrl("postgres://user:pass@localhost/app"), "postgres://user:pass@localhost/app");
  assert.throws(() => assertLocalPostgresUrl("postgresql://user:pass@db.example.com/app"), /só aceita PostgreSQL local/);
  assert.throws(() => assertLocalPostgresUrl("http://127.0.0.1/app"), /só aceita PostgreSQL local/);
});

test("installs each app with npm ci from that app directory", () => {
  const api = installPlan("apps/api");
  const web = installPlan("apps/web");
  assert.deepEqual(api.args, ["ci"]);
  assert.equal(api.args.includes("--prefix"), false);
  assert.match(api.cwd, /apps[/\\]api$/);
  assert.match(web.cwd, /apps[/\\]web$/);
  assert.notEqual(api.cwd, web.cwd);
});
