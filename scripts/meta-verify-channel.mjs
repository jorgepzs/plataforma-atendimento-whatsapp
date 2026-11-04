import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateMetaLocalText } from "./meta-local.mjs";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_FILE = fileURLToPath(new URL("../.env.meta.local", import.meta.url));
const EXPECTED_PHONE_ID = /^[1-9][0-9]{0,31}$/;

function failure(code, extra = {}) {
  return { ok: false, code, ...extra };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedTimeout(timeoutMs) {
  if (timeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

async function classifyResponse(response, expectedPhoneId) {
  if (!isRecord(response) || !Number.isInteger(response.status)) {
    return failure("INVALID_RESPONSE");
  }

  const status = response.status;
  if (status < 100 || status > 599) {
    return failure("INVALID_RESPONSE");
  }

  if (status < 200 || status >= 300) {
    let errorCode;
    try {
      if (typeof response.json === "function") {
        const payload = await response.json();
        if (isRecord(payload) && isRecord(payload.error) && Number.isInteger(payload.error.code)) {
          errorCode = payload.error.code;
        }
      }
    } catch {
      // Error payloads are optional; only their integer Meta code is exposed.
    }

    return failure("HTTP_ERROR", {
      httpStatus: status,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  if (typeof response.json !== "function") {
    return failure("INVALID_RESPONSE");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return failure("INVALID_RESPONSE");
  }

  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return failure("INVALID_RESPONSE");
  }

  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !EXPECTED_PHONE_ID.test(entry.id)) {
      return failure("INVALID_RESPONSE");
    }
  }

  if (payload.data.some((entry) => entry.id === expectedPhoneId)) {
    return { ok: true, code: "CHANNEL_CONFIRMED" };
  }

  return failure("CHANNEL_NOT_IN_FIRST_PAGE");
}

/** Read-only check that the configured phone ID appears on the WABA's first page. */
export async function verifyMetaChannelText(source, options = {}) {
  const validation = validateMetaLocalText(source);
  if (!validation.ok) {
    return failure("LOCAL_INVALID");
  }

  const timeoutMs = normalizedTimeout(options?.timeoutMs);
  if (timeoutMs === null) {
    return failure("LOCAL_INVALID");
  }

  let config;
  try {
    config = parseEnv(source);
  } catch {
    return failure("LOCAL_INVALID");
  }

  const phoneId = config.META_PHONE_NUMBER_ID;
  const wabaId = config.META_WABA_ID;
  const graphVersion = config.META_GRAPH_API_VERSION;
  const accessToken = config.META_ACCESS_TOKEN;
  if (
    !EXPECTED_PHONE_ID.test(phoneId ?? "") || !EXPECTED_PHONE_ID.test(wabaId ?? "") ||
    !/^v[1-9][0-9]*\.[0-9]+$/.test(graphVersion ?? "") ||
    typeof accessToken !== "string" || accessToken.length > 8192 ||
    !/^[A-Za-z0-9._~+/-]+={0,}$/.test(accessToken) || config.META_OUTBOUND_ENABLED !== "false"
  ) {
    return failure("LOCAL_INVALID");
  }

  const fetchTransport = options?.fetchTransport ?? globalThis.fetch;
  if (typeof fetchTransport !== "function") {
    return failure("LOCAL_INVALID");
  }

  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/phone_numbers?fields=id&limit=100`;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });

  const request = Promise.resolve()
    .then(() => fetchTransport(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: controller.signal,
    }))
    .then((response) => classifyResponse(response, phoneId))
    .then((result) => ({ result }))
    .catch(() => ({ result: failure("NETWORK_ERROR") }));

  try {
    const settled = await Promise.race([request, timeout]);
    if (settled.timedOut) {
      return failure("NETWORK_TIMEOUT");
    }
    return settled.result;
  } catch {
    return failure("NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

function parseArguments(args) {
  let confirmed = false;
  let file = DEFAULT_FILE;
  let fileSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--confirm-read-only" && !confirmed) {
      confirmed = true;
      continue;
    }
    if (args[index] === "--file" && !fileSeen && index + 1 < args.length && args[index + 1] !== "") {
      file = path.resolve(args[index + 1]);
      fileSeen = true;
      index += 1;
      continue;
    }
    return { valid: false, confirmed };
  }

  return { valid: true, confirmed, file };
}

function cliFailure(code, metadata = {}) {
  const suffix = [
    Number.isInteger(metadata.httpStatus) ? `HTTP_STATUS=${metadata.httpStatus}` : null,
    Number.isInteger(metadata.errorCode) ? `META_ERROR_CODE=${metadata.errorCode}` : null,
  ].filter(Boolean).join("; ");
  process.stderr.write(`Verificação não concluída. ${code}${suffix ? `; ${suffix}` : ""}\n`);
  process.exitCode = 1;
}

async function runCli(args) {
  const parsedArgs = parseArguments(args);
  if (!parsedArgs.confirmed) {
    cliFailure("CONFIRMATION_REQUIRED");
    return;
  }
  if (!parsedArgs.valid) {
    cliFailure("LOCAL_INVALID");
    return;
  }

  let contents;
  try {
    contents = await readFile(parsedArgs.file);
  } catch {
    cliFailure("LOCAL_INVALID");
    return;
  }

  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    cliFailure("LOCAL_INVALID");
    return;
  }

  const result = await verifyMetaChannelText(source);
  if (!result.ok) {
    cliFailure(result.code, result);
    return;
  }

  process.stdout.write(
    "Canal confirmado na primeira página: acesso de leitura ao WABA e vínculo do número verificados. Isso não valida permissão de envio nem expiração futura; nenhum envio foi feito.\n",
  );
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  const invokedUrl = pathToFileURL(path.resolve(process.argv[1])).href;
  return process.platform === "win32"
    ? invokedUrl.toLowerCase() === import.meta.url.toLowerCase()
    : invokedUrl === import.meta.url;
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch(() => {
    cliFailure("NETWORK_ERROR");
  });
}
