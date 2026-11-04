import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateMetaLocalText } from "./meta-local.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./meta-local.mjs", import.meta.url));
const FAKE_TOKEN = "EAAFAKE_TESTTOKEN1234567890";

function validEntries(overrides = {}) {
  return {
    META_PHONE_NUMBER_ID: "12345678901234567890123456789012",
    META_WABA_ID: "987654321",
    META_GRAPH_API_VERSION: "v23.0",
    META_ACCESS_TOKEN: FAKE_TOKEN,
    META_OUTBOUND_ENABLED: "false",
    ...overrides,
  };
}

function envText(entries = validEntries()) {
  return Object.entries(validEntries(entries))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function assertIssue(result, field, code) {
  assert.equal(result.ok, false, "invalid configuration should fail");
  assert.ok(
    result.issues.some((issue) => issue.field === field && issue.code === code),
    "expected a sanitized field/code issue",
  );
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, "CLI process should start");
  return result;
}

function assertNoTokenLeak(result) {
  assert.ok(!result.stdout.includes(FAKE_TOKEN), "stdout must not contain a credential");
  assert.ok(!result.stderr.includes(FAKE_TOKEN), "stderr must not contain a credential");
}

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meta-local-test-"));
  t.after(async () => {
    const resolvedDirectory = path.resolve(directory);
    assert.equal(path.dirname(resolvedDirectory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolvedDirectory).startsWith("meta-local-test-"));
    await rm(resolvedDirectory, { recursive: true, force: true });
  });
  return directory;
}

async function writeFixture(directory, contents) {
  const file = path.join(directory, ".env.meta.local");
  await writeFile(file, contents, "utf8");
  return file;
}

test("accepts a complete offline configuration without returning its values", () => {
  assert.deepEqual(validateMetaLocalText(envText()), { ok: true, issues: [] });
});

test("rejects missing required fields", () => {
  const result = validateMetaLocalText("");
  assert.equal(result.ok, false);
  for (const field of [
    "META_PHONE_NUMBER_ID",
    "META_WABA_ID",
    "META_GRAPH_API_VERSION",
    "META_ACCESS_TOKEN",
    "META_OUTBOUND_ENABLED",
  ]) {
    assert.ok(
      result.issues.some((issue) => issue.field === field && issue.code === "MISSING_FIELD"),
      "each required field should be named without exposing values",
    );
  }
});

test("rejects placeholder access tokens", () => {
  for (const token of ["YOUR_ACCESS_TOKEN", "SEU_TOKEN", "COLE_TOKEN_AQUI", "troque-este-token"]) {
    const result = validateMetaLocalText(envText({ META_ACCESS_TOKEN: token }));
    assertIssue(result, "META_ACCESS_TOKEN", "PLACEHOLDER_VALUE");
  }
});

test("rejects invalid IDs, Graph versions, and bearer token syntax", () => {
  const invalidCases = [
    ["META_PHONE_NUMBER_ID", "0"],
    ["META_PHONE_NUMBER_ID", "00123"],
    ["META_WABA_ID", "123456789012345678901234567890123"],
    ["META_GRAPH_API_VERSION", "latest"],
    ["META_GRAPH_API_VERSION", "v0.0"],
    ["META_ACCESS_TOKEN", "EAA badtoken"],
    ["META_ACCESS_TOKEN", "EAA?badtoken"],
  ];

  for (const [field, value] of invalidCases) {
    const result = validateMetaLocalText(envText({ [field]: value }));
    assertIssue(result, field, "INVALID_VALUE");
  }
});

test("enforces the bearer-token byte limit", () => {
  const result = validateMetaLocalText(envText({ META_ACCESS_TOKEN: `EAA${"a".repeat(8190)}` }));
  assertIssue(result, "META_ACCESS_TOKEN", "INVALID_VALUE");
});

test("requires outbound sending to be exactly false", () => {
  const result = validateMetaLocalText(envText({ META_OUTBOUND_ENABLED: "true" }));
  assertIssue(result, "META_OUTBOUND_ENABLED", "OUTBOUND_MUST_BE_FALSE");
});

test("rejects unknown and duplicate keys without echoing their contents", async (t) => {
  const directory = await tempDirectory(t);
  const file = await writeFixture(
    directory,
    `${envText()}\nPRIVATE_UNKNOWN_FIELD=PRIVATE_SENTINEL_2026\nMETA_WABA_ID=111222333`,
  );
  const result = runCli(["--file", file]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /UNKNOWN_FIELD: UNKNOWN_FIELD/);
  assert.match(result.stderr, /META_WABA_ID: DUPLICATE_FIELD/);
  assert.ok(!result.stderr.includes("PRIVATE_SENTINEL_2026"), "unknown values must stay private");
  assertNoTokenLeak(result);
});

test("CLI success confirms syntax only, remains offline, and does not reveal the token", async (t) => {
  const directory = await tempDirectory(t);
  const file = await writeFixture(directory, envText());
  const result = runCli(["--file", file]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Configuração sintaticamente completa/);
  assert.match(result.stdout, /ainda não foram validados na Meta/);
  assert.match(result.stdout, /envio permanece desativado/);
  assert.equal(result.stderr, "");
  assertNoTokenLeak(result);
});

test("CLI reports a missing file without exposing its path or raw error", async (t) => {
  const directory = await tempDirectory(t);
  const missingPath = path.join(directory, "absent.env");
  const result = runCli(["--file", missingPath]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /FILE: NOT_FOUND/);
  assert.ok(!result.stderr.includes(missingPath), "file paths must not be printed");
  assertNoTokenLeak(result);
});

test("CLI rejects malformed and oversized files with sanitized diagnostics", async (t) => {
  const directory = await tempDirectory(t);
  const malformedFile = await writeFixture(directory, `${envText()}\nnot an assignment`);
  const malformed = runCli(["--file", malformedFile]);

  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /FILE: INVALID_FORMAT/);
  assert.ok(!malformed.stderr.includes("not an assignment"), "raw file lines must not be printed");
  assertNoTokenLeak(malformed);

  const oversizedFile = await writeFixture(directory, `#${"x".repeat(32 * 1024)}`);
  const oversized = runCli(["--file", oversizedFile]);
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /FILE: TOO_LARGE/);
  assertNoTokenLeak(oversized);
});

test("CLI rejects invalid UTF-8 and unsupported arguments", async (t) => {
  const directory = await tempDirectory(t);
  const invalidUtf8File = path.join(directory, "invalid-utf8.env");
  await writeFile(invalidUtf8File, Buffer.from([0xff, 0xfe]));
  const invalidUtf8 = runCli(["--file", invalidUtf8File]);
  assert.equal(invalidUtf8.status, 1);
  assert.match(invalidUtf8.stderr, /FILE: INVALID_FORMAT/);
  assertNoTokenLeak(invalidUtf8);

  const invalidArgs = runCli(["--unexpected"]);
  assert.equal(invalidArgs.status, 1);
  assert.match(invalidArgs.stderr, /CLI_ARGUMENTS: INVALID_USAGE/);
  assertNoTokenLeak(invalidArgs);
});

