import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyMetaChannelText } from "./meta-verify-channel.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./meta-verify-channel.mjs", import.meta.url));
const FAKE_TOKEN = "EAAFAKE_TESTTOKEN1234567890";
const PHONE_ID = "12345678901234567890123456789012";
const WABA_ID = "987654321";
const GRAPH_VERSION = "v23.0";
const EXPECTED_URL = `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/phone_numbers?fields=id&limit=100`;

function source(overrides = {}) {
  const entries = {
    META_PHONE_NUMBER_ID: PHONE_ID,
    META_WABA_ID: WABA_ID,
    META_GRAPH_API_VERSION: GRAPH_VERSION,
    META_ACCESS_TOKEN: FAKE_TOKEN,
    META_OUTBOUND_ENABLED: "false",
    ...overrides,
  };
  return Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n");
}

function jsonResponse(status, payload) {
  return { status, json: async () => payload };
}

function assertNoSensitiveResultData(result) {
  const serialized = JSON.stringify(result);
  for (const value of [FAKE_TOKEN, EXPECTED_URL, PHONE_ID, WABA_ID, "private-provider-message"]) {
    assert.ok(!serialized.includes(value), "verification result must contain metadata only");
  }
}

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "meta-verify-test-"));
  t.after(async () => {
    const resolvedDirectory = path.resolve(directory);
    assert.equal(path.dirname(resolvedDirectory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolvedDirectory).startsWith("meta-verify-test-"));
    await rm(resolvedDirectory, { recursive: true, force: true });
  });
  return directory;
}

test("sends one GET to the fixed read-only endpoint with bearer auth and redirect:error", async () => {
  let calls = 0;
  let request;
  const result = await verifyMetaChannelText(source(), {
    fetchTransport: async (url, options) => {
      calls += 1;
      request = { url, options };
      return jsonResponse(200, { data: [{ id: PHONE_ID }] });
    },
    timeoutMs: 1000,
  });

  assert.deepEqual(result, { ok: true, code: "CHANNEL_CONFIRMED" });
  assert.equal(calls, 1, "verification makes one request with no retries");
  assert.ok(request.url === EXPECTED_URL, "request uses the fixed Graph URL");
  assert.ok(request.options.method === "GET", "request method is read-only GET");
  assert.ok(request.options.redirect === "error", "redirects are rejected");
  assert.ok(
    request.options.headers.Authorization === `Bearer ${FAKE_TOKEN}`,
    "bearer token is sent only in the Authorization header",
  );
  assert.ok(request.options.headers.Accept === "application/json", "JSON response is requested");
  assert.ok(!Object.hasOwn(request.options, "body"), "GET request has no body");
  assert.ok(request.options.signal instanceof AbortSignal, "request has an abort signal");
  assertNoSensitiveResultData(result);
});

test("does not call transport when local configuration or disabled sending is invalid", async () => {
  let calls = 0;
  const fetchTransport = async () => {
    calls += 1;
    return jsonResponse(200, { data: [{ id: PHONE_ID }] });
  };

  const invalidInputs = [
    source({ META_OUTBOUND_ENABLED: "true" }),
    source({ META_ACCESS_TOKEN: "YOUR_ACCESS_TOKEN" }),
    source({ META_PHONE_NUMBER_ID: "0" }),
    source({ META_GRAPH_API_VERSION: "v0.0" }),
    source({ META_WABA_ID: "../me" }),
    source().replace("\nMETA_OUTBOUND_ENABLED=false", ""),
  ];

  for (const invalidSource of invalidInputs) {
    const result = await verifyMetaChannelText(invalidSource, { fetchTransport, timeoutMs: 1000 });
    assert.deepEqual(result, { ok: false, code: "LOCAL_INVALID" });
  }
  assert.equal(calls, 0, "invalid local configuration never reaches transport");
});

test("confirms a matching phone ID from the first data page only", async () => {
  let calls = 0;
  const result = await verifyMetaChannelText(source(), {
    fetchTransport: async () => {
      calls += 1;
      return jsonResponse(200, {
        data: [{ id: PHONE_ID }],
        paging: { next: "https://untrusted.example/next-page" },
      });
    },
  });

  assert.deepEqual(result, { ok: true, code: "CHANNEL_CONFIRMED" });
  assert.equal(calls, 1, "pagination links are not followed");
  assertNoSensitiveResultData(result);
});

test("reports a valid first page that does not contain the configured ID", async () => {
  const result = await verifyMetaChannelText(source(), {
    fetchTransport: async () => jsonResponse(200, { data: [{ id: "111222333" }] }),
  });

  assert.deepEqual(result, { ok: false, code: "CHANNEL_NOT_IN_FIRST_PAGE" });
  assertNoSensitiveResultData(result);
});

test("rejects malformed success JSON without exposing its contents", async () => {
  const malformedResponses = [
    { status: 200, json: async () => { throw new Error("private-provider-message"); } },
    jsonResponse(200, { data: "not-an-array" }),
    jsonResponse(200, { data: [{}] }),
  ];

  for (const response of malformedResponses) {
    const result = await verifyMetaChannelText(source(), { fetchTransport: async () => response });
    assert.deepEqual(result, { ok: false, code: "INVALID_RESPONSE" });
    assertNoSensitiveResultData(result);
  }
});

test("sanitizes 401 and 403 responses to status and optional integer Meta code", async () => {
  for (const [status, errorCode] of [[401, 190], [403, 10]]) {
    const result = await verifyMetaChannelText(source(), {
      fetchTransport: async () => jsonResponse(status, {
        error: { message: "private-provider-message", code: errorCode },
      }),
    });

    assert.deepEqual(result, { ok: false, code: "HTTP_ERROR", httpStatus: status, errorCode });
    assertNoSensitiveResultData(result);
  }
});

test("returns network-timeout and aborts when transport ignores cancellation", async () => {
  let signal;
  let calls = 0;
  const result = await verifyMetaChannelText(source(), {
    fetchTransport: (_url, options) => {
      calls += 1;
      signal = options.signal;
      return new Promise(() => {});
    },
    timeoutMs: 30,
  });

  assert.deepEqual(result, { ok: false, code: "NETWORK_TIMEOUT" });
  assert.equal(calls, 1, "timeout does not retry the request");
  assert.equal(signal.aborted, true, "timeout aborts the request signal");
  assertNoSensitiveResultData(result);
});

test("timeout covers response JSON parsing", async () => {
  let signal;
  const result = await verifyMetaChannelText(source(), {
    fetchTransport: async (_url, options) => {
      signal = options.signal;
      return { status: 200, json: () => new Promise(() => {}) };
    },
    timeoutMs: 30,
  });

  assert.deepEqual(result, { ok: false, code: "NETWORK_TIMEOUT" });
  assert.equal(signal.aborted, true, "body timeout aborts the request signal");
  assertNoSensitiveResultData(result);
});

test("sanitizes thrown network errors and does not retry", async () => {
  let calls = 0;
  const result = await verifyMetaChannelText(source(), {
    fetchTransport: async () => {
      calls += 1;
      throw new Error(`private-provider-message ${FAKE_TOKEN} ${EXPECTED_URL}`);
    },
  });

  assert.deepEqual(result, { ok: false, code: "NETWORK_ERROR" });
  assert.equal(calls, 1, "a failed GET is not retried");
  assertNoSensitiveResultData(result);
});

test("CLI without --confirm-read-only refuses before reading the supplied file", async (t) => {
  const directory = await tempDirectory(t);
  const nonexistentFile = path.join(directory, "must-not-be-read.env");
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--file", nonexistentFile], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined, "CLI process should start");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /CONFIRMATION_REQUIRED/);
  assert.ok(!result.stderr.includes("LOCAL_INVALID"), "missing-file result would show the file was read");
  assert.ok(!result.stderr.includes(nonexistentFile), "file path is never printed");
  assert.ok(!result.stderr.includes(FAKE_TOKEN), "token is never printed");
});

