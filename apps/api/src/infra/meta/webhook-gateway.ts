import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

const WEBHOOK_PATH = "/webhooks/meta";
const LOCAL_UPSTREAM_URL = "http://127.0.0.1:3000/webhooks/meta";
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 5_000;
const UPSTREAM_RESPONSE_LIMIT_BYTES = 16 * 1024;
const SIGNATURE_PREFIX = "sha256=";

export interface BuildWebhookGatewayOptions {
  appSecret: string;
  verifyToken: string;
  localUpstreamSecret: string;
  fetchTransport?: typeof fetch;
}

type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };

class UpstreamTimeoutError extends Error {}

class InvalidUpstreamResponseError extends Error {}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; the public response stays generic.
  }
}

function isPlaceholder(value: string): boolean {
  return /^(?:change[-_ ]?me|replace[-_ ]?me|your(?:[-_ ]|$)|example(?:[-_ ]|$)|placeholder(?:[-_ ]|$)|development(?:[-_ ]|$)|dev(?:[-_ ]|$)|test(?:[-_ ]|$)|secret(?:[-_ ]|$)|none$|null$|undefined$|todo$)/i.test(value);
}

function isPrintableSecret(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value) && value === value.trim();
}

function validateOptions(options: BuildWebhookGatewayOptions): void {
  const validAppSecret = typeof options.appSecret === "string" && /^[a-f\d]{32}$/i.test(options.appSecret) && !isPlaceholder(options.appSecret);
  const validVerifyToken = typeof options.verifyToken === "string" && options.verifyToken.length >= 8 && options.verifyToken.length <= 256 && isPrintableSecret(options.verifyToken) && !isPlaceholder(options.verifyToken);
  const validLocalSecret = typeof options.localUpstreamSecret === "string" &&
    (options.localUpstreamSecret === "dev-app-secret" || options.localUpstreamSecret.length >= 32) &&
    options.localUpstreamSecret.length <= 256 && isPrintableSecret(options.localUpstreamSecret) &&
    (options.localUpstreamSecret === "dev-app-secret" || !isPlaceholder(options.localUpstreamSecret));
  const distinctSecrets = options.appSecret !== options.verifyToken && options.appSecret !== options.localUpstreamSecret && options.verifyToken !== options.localUpstreamSecret;

  if (!validAppSecret || !validVerifyToken || !validLocalSecret || !distinctSecrets) {
    throw new Error("Webhook gateway configuration is invalid.");
  }
}

function signatureFor(rawBody: Buffer, secret: string): string {
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}

function hasValidSignature(rawBody: Buffer, provided: unknown, appSecret: string): boolean {
  if (typeof provided !== "string") return false;
  const match = /^sha256=([a-f\d]{64})$/i.exec(provided);
  if (!match?.[1]) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(expected, received);
}

function getJsonContentType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(value)) return undefined;
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSummaryCount(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) > UPSTREAM_RESPONSE_LIMIT_BYTES)) {
    await cancelResponseBody(response);
    throw new InvalidUpstreamResponseError();
  }

  if (!response.body) throw new InvalidUpstreamResponseError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > UPSTREAM_RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new InvalidUpstreamResponseError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch {
    throw new InvalidUpstreamResponseError();
  }
}

async function validateUpstreamResponse(response: Response): Promise<"accepted" | "unknown-channel"> {
  if (response.status !== 200) {
    await cancelResponseBody(response);
    throw new InvalidUpstreamResponseError();
  }

  const contentType = response.headers.get("content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    await cancelResponseBody(response);
    throw new InvalidUpstreamResponseError();
  }

  const bodyText = await readBoundedResponseBody(response);
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new InvalidUpstreamResponseError();
  }

  if (!isObject(body) || body.received !== true || Object.keys(body).length !== 1) {
    throw new InvalidUpstreamResponseError();
  }

  const normalized = getSummaryCount(response, "x-webhook-normalized");
  const enqueued = getSummaryCount(response, "x-webhook-enqueued");
  const duplicates = getSummaryCount(response, "x-webhook-duplicates");
  const unknownChannels = getSummaryCount(response, "x-webhook-unknown-channels");
  if ([normalized, enqueued, duplicates, unknownChannels].some((value) => value === undefined)) {
    throw new InvalidUpstreamResponseError();
  }
  if (enqueued! + duplicates! + unknownChannels! !== normalized!) throw new InvalidUpstreamResponseError();

  return unknownChannels! > 0 ? "unknown-channel" : "accepted";
}

function readVerificationQuery(rawUrl: string): { mode: string; verifyToken: string; challenge: string } | undefined {
  if (rawUrl.length > 4_096 || !rawUrl.startsWith(`${WEBHOOK_PATH}?`)) return undefined;

  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return undefined;
  }
  if (url.pathname !== WEBHOOK_PATH) return undefined;

  const mode = url.searchParams.getAll("hub.mode");
  const verifyToken = url.searchParams.getAll("hub.verify_token");
  const challenge = url.searchParams.getAll("hub.challenge");
  if (mode.length !== 1 || verifyToken.length !== 1 || challenge.length !== 1) return undefined;

  const [modeValue] = mode;
  const [tokenValue] = verifyToken;
  const [challengeValue] = challenge;
  if (modeValue === undefined || tokenValue === undefined || challengeValue === undefined) return undefined;
  if (Buffer.byteLength(tokenValue, "utf8") > 256 || Buffer.byteLength(challengeValue, "utf8") > 1_024 || challengeValue.length === 0) return undefined;

  return { mode: modeValue, verifyToken: tokenValue, challenge: challengeValue };
}

export async function buildWebhookGateway(options: BuildWebhookGatewayOptions): Promise<FastifyInstance> {
  validateOptions(options);

  const fetchTransport = options.fetchTransport ?? fetch;
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    exposeHeadRoutes: false,
    routerOptions: {
      ignoreTrailingSlash: false,
      caseSensitive: true
    }
  });

  // Parse only JSON into bytes. A global raw-body hook also runs for text/plain
  // and can crash raw-body while that content parser supplies a string.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    try {
      if (!Buffer.isBuffer(body)) throw new Error("invalid_json");
      (request as RequestWithRawBody).rawBody = body;
      done(null, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    } catch {
      done(new Error("invalid_json"), undefined);
    }
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: "not_found" }));
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    if (statusCode === 413) return reply.status(413).send({ error: "request_too_large" });
    if (statusCode === 415) return reply.status(415).send({ error: "unsupported_media_type" });
    if (statusCode >= 400 && statusCode < 500) return reply.status(statusCode).send({ error: "invalid_webhook_request" });
    return reply.status(400).send({ error: "invalid_webhook_request" });
  });

  app.get(WEBHOOK_PATH, async (request, reply) => {
    const rawUrl = request.raw.url ?? "";
    const verification = readVerificationQuery(rawUrl);
    if (!verification || verification.mode !== "subscribe" || verification.verifyToken !== options.verifyToken) {
      return reply.status(403).send({ error: "webhook_verification_failed" });
    }

    return reply.type("text/plain; charset=utf-8").send(verification.challenge);
  });

  app.post(WEBHOOK_PATH, async (request, reply) => {
    if ((request.raw.url ?? "").includes("?")) {
      return reply.status(400).send({ error: "invalid_webhook_request" });
    }

    const contentType = getJsonContentType(request.headers["content-type"]);
    if (!contentType) return reply.status(415).send({ error: "unsupported_media_type" });
    if (request.headers["content-encoding"] !== undefined) {
      return reply.status(415).send({ error: "unsupported_media_type" });
    }

    const rawBody = (request as RequestWithRawBody).rawBody;
    if (!rawBody || rawBody.length > BODY_LIMIT_BYTES || !hasValidSignature(rawBody, request.headers["x-hub-signature-256"], options.appSecret)) {
      return reply.status(401).send({ error: "invalid_webhook_signature" });
    }

    if (!isObject(request.body)) return reply.status(400).send({ error: "invalid_webhook_request" });

    const upstreamSignature = signatureFor(rawBody, options.localUpstreamSecret);
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new UpstreamTimeoutError());
      }, UPSTREAM_TIMEOUT_MS);
    });

    try {
      const upstreamWork = (async () => {
        const response = await fetchTransport(LOCAL_UPSTREAM_URL, {
          method: "POST",
          headers: {
            "content-type": contentType,
            "x-hub-signature-256": upstreamSignature
          },
          body: Uint8Array.from(rawBody),
          redirect: "error",
          signal: controller.signal
        });
        return await validateUpstreamResponse(response);
      })();

      const result = await Promise.race([upstreamWork, timeout]);
      if (result === "unknown-channel") {
        return reply.status(503).send({ error: "webhook_channel_unmapped" });
      }
      return reply.status(200).send({ received: true });
    } catch (error) {
      if (timedOut || error instanceof UpstreamTimeoutError) {
        return reply.status(504).send({ error: "webhook_upstream_timeout" });
      }
      return reply.status(502).send({ error: "webhook_upstream_unavailable" });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  });

  return app;
}
