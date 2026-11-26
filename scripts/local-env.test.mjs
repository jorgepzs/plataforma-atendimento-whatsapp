import assert from "node:assert/strict";
import test from "node:test";
import { selectDocumentedEnvironment } from "./local-env.mjs";
import { installPlan } from "./install-all.mjs";

test("keeps WhatsApp, LLM and local AI settings from the env file", () => {
  const selected = selectDocumentedEnvironment({
    WHATSAPP_CHANNEL_ENABLED: "true",
    WHATSAPP_PROVIDER: "unofficial_qr",
    LLM_MODEL: "qwen2.5:1.5b",
    LOCAL_AI_ENABLED: "false",
    PATH: "/usr/bin",
    npm_config_cache: "/tmp"
  });
  assert.equal(selected.WHATSAPP_CHANNEL_ENABLED, "true");
  assert.equal(selected.WHATSAPP_PROVIDER, "unofficial_qr");
  assert.equal(selected.LLM_MODEL, "qwen2.5:1.5b");
  assert.equal(selected.LOCAL_AI_ENABLED, "false");
  assert.equal(selected.PATH, undefined);
  assert.equal(selected.npm_config_cache, undefined);
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
