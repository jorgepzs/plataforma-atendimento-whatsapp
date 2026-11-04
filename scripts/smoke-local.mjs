import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const localSmokeCredentials = Object.freeze({
  verifyToken: "dev-verify-token",
  appSecret: "dev-app-secret"
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5_000)
  });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function signBody(body, appSecret) {
  const digest = createHmac("sha256", appSecret).update(body).digest("hex");
  return `sha256=${digest}`;
}

function assertSafeTarget(value, label) {
  const url = new URL(value);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const remoteAllowed = process.env.ALLOW_REMOTE_SMOKE === "true";

  assert(["http:", "https:"].includes(url.protocol), `${label} deve usar HTTP ou HTTPS.`);
  assert(
    localHosts.has(url.hostname) || remoteAllowed,
    `${label} aponta para ${url.hostname}. Por segurança, defina ALLOW_REMOTE_SMOKE=true para testar um destino não local.`
  );
}

async function runAttendanceSmoke(apiUrl) {
  const login = await fetchWithTimeout(`${apiUrl}/api/v1/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pizzaria@atende.local", password: "AtendeLocal123!" })
  });
  assert(login.status === 200, `Login local retornou HTTP ${login.status}.`);
  const session = await readJson(login);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert(cookie && session?.csrfToken, "O login não criou sessão e token CSRF.");
  const headers = { cookie, "x-csrf-token": session.csrfToken, "content-type": "application/json" };
  const actionHeaders = { cookie, "x-csrf-token": session.csrfToken };
  const tenants = await fetchWithTimeout(`${apiUrl}/api/v1/tenants`, { headers });
  const tenantsBody = await readJson(tenants);
  assert(tenants.status === 200 && tenantsBody?.tenants?.length === 1 && tenantsBody.tenants[0].id === "pizzaria-demo", "O atendente não ficou restrito ao seu cliente.");
  const forbidden = await fetchWithTimeout(`${apiUrl}/api/v1/tenants/barbearia-demo/config`, { headers });
  assert(forbidden.status === 403, "Um atendente conseguiu acessar outro cliente.");

  const base = `${apiUrl}/api/v1/tenants/pizzaria-demo`;
  const customerPhone = `5511${String(Date.now()).slice(-9)}`;
  const simulated = await fetchWithTimeout(`${base}/simulate`, {
    method: "POST", headers,
    body: JSON.stringify({ customerName: "Cliente Smoke", customerPhone, text: "Quero falar com um atendente humano" })
  });
  assert(simulated.status === 202, `O simulador retornou HTTP ${simulated.status}.`);
  let conversation;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const queue = await fetchWithTimeout(`${base}/conversations`, { headers });
    const queueBody = await readJson(queue);
    conversation = queueBody?.conversations?.find((item) => item.customerPhone === customerPhone);
    if (conversation?.state === "WAITING_HUMAN") break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert(conversation?.state === "WAITING_HUMAN", "O worker não encaminhou a mensagem para a fila humana.");
  const conversationUrl = `${base}/conversations/${encodeURIComponent(conversation.id)}`;
  const claimed = await fetchWithTimeout(`${conversationUrl}/claim`, { method: "POST", headers: actionHeaders });
  assert(claimed.status === 200, "Não foi possível assumir a conversa.");
  const reply = await fetchWithTimeout(`${conversationUrl}/reply`, {
    method: "POST", headers, body: JSON.stringify({ text: "Resposta do teste local." })
  });
  const replyBody = await readJson(reply);
  assert(reply.status === 200 && replyBody?.message?.deliveryStatus === "SIMULATED", "A resposta do atendente não foi registrada como simulada.");
  const detail = await fetchWithTimeout(conversationUrl, { headers });
  const detailBody = await readJson(detail);
  assert(detailBody?.messages?.some((item) => item.role === "CUSTOMER") && detailBody.messages.some((item) => item.role === "ATTENDANT"), "O histórico não contém mensagem recebida e resposta humana.");
  const closed = await fetchWithTimeout(`${conversationUrl}/close`, { method: "POST", headers: actionHeaders });
  const closedBody = await readJson(closed);
  assert(closed.status === 200 && closedBody?.conversation?.state === "CLOSED", "O atendimento não foi encerrado.");
  const logout = await fetchWithTimeout(`${apiUrl}/api/v1/auth/logout`, { method: "POST", headers: actionHeaders });
  assert(logout.status === 204, "Logout falhou.");
  const invalidated = await fetchWithTimeout(`${apiUrl}/api/v1/auth/me`, { headers });
  assert(invalidated.status === 401, "Uma sessão encerrada continua válida.");
  console.log("PASS local session, tenant isolation, worker, queue, human reply, close and logout");
}

export async function runSmoke({
  apiBaseUrl = process.env.LOCAL_API_URL ?? "http://127.0.0.1:3000",
  webBaseUrl = process.env.LOCAL_WEB_URL ?? "http://127.0.0.1:5173",
  verifyToken = localSmokeCredentials.verifyToken,
  appSecret = localSmokeCredentials.appSecret,
  expectedStore
} = {}) {
  const apiUrl = apiBaseUrl.replace(/\/$/, "");
  const webUrl = webBaseUrl.replace(/\/$/, "");
  assertSafeTarget(apiUrl, "LOCAL_API_URL");
  assertSafeTarget(webUrl, "LOCAL_WEB_URL");

  const live = await fetchWithTimeout(`${apiUrl}/health/live`);
  assert(live.status === 200, `GET /health/live retornou HTTP ${live.status}.`);
  assert((await readJson(live))?.status === "ok", "GET /health/live não retornou status ok.");
  console.log("PASS API liveness");

  const ready = await fetchWithTimeout(`${apiUrl}/health/ready`);
  const readyBody = await readJson(ready);
  assert(ready.status === 200, `GET /health/ready retornou HTTP ${ready.status}.`);
  assert(readyBody?.status === "ready", "GET /health/ready não retornou status ready.");
  assert(readyBody?.dependencies?.eventStore?.status === "up", "O armazenamento de eventos não está pronto.");
  console.log("PASS API readiness");

  const info = await fetchWithTimeout(`${apiUrl}/api/v1/system/info`);
  const infoBody = await readJson(info);
  assert(info.status === 200, `GET /api/v1/system/info retornou HTTP ${info.status}.`);
  assert(infoBody?.version === "0.1.0", "Informações do sistema não retornaram a versão esperada.");
  assert(infoBody?.capabilities?.includes("meta.webhook.receive"), "A API não anunciou o recebimento de webhooks.");
  if (expectedStore) assert(infoBody?.eventStore === expectedStore, `A API deveria usar store ${expectedStore}.`);
  console.log("PASS API system info");

  const verificationUrl = new URL(`${apiUrl}/webhooks/meta`);
  verificationUrl.searchParams.set("hub.mode", "subscribe");
  verificationUrl.searchParams.set("hub.verify_token", verifyToken);
  verificationUrl.searchParams.set("hub.challenge", "local-challenge");
  const verification = await fetchWithTimeout(verificationUrl);
  assert(verification.status === 200, `Verificação do webhook retornou HTTP ${verification.status}.`);
  assert((await verification.text()) === "local-challenge", "A verificação do webhook não devolveu o challenge.");

  const rejectedUrl = new URL(`${apiUrl}/webhooks/meta`);
  rejectedUrl.searchParams.set("hub.mode", "subscribe");
  rejectedUrl.searchParams.set("hub.verify_token", `${verifyToken}-wrong`);
  rejectedUrl.searchParams.set("hub.challenge", "local-challenge");
  const rejectedVerification = await fetchWithTimeout(rejectedUrl);
  assert(rejectedVerification.status === 403, `Token incorreto deveria retornar HTTP 403, recebeu ${rejectedVerification.status}.`);
  console.log("PASS Meta webhook verification and rejection");

  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "local-phone-number" },
              contacts: [{ wa_id: "5511999999999", profile: { name: "Teste Local" } }],
              messages: [
                {
                  id: `wamid.local-smoke-${Date.now()}`,
                  from: "5511999999999",
                  timestamp: String(Math.floor(Date.now() / 1_000)),
                  type: "text",
                  text: { body: "Mensagem de smoke test local" }
                }
              ]
            }
          }
        ]
      }
    ]
  };
  const body = JSON.stringify(payload);
  const signature = signBody(body, appSecret);
  const webhookHeaders = {
    "content-type": "application/json",
    "x-hub-signature-256": signature
  };

  const expectedDeliveries = [
    { enqueued: "1", duplicates: "0" },
    { enqueued: "0", duplicates: "1" }
  ];

  for (const [index, expected] of expectedDeliveries.entries()) {
    const accepted = await fetchWithTimeout(`${apiUrl}/webhooks/meta`, {
      method: "POST",
      headers: webhookHeaders,
      body
    });
    const delivery = index + 1;
    assert(accepted.status === 200, `Entrega assinada ${delivery} retornou HTTP ${accepted.status}.`);
    assert((await readJson(accepted))?.received === true, `Entrega assinada ${delivery} não foi confirmada.`);
    assert(
      accepted.headers.get("x-webhook-enqueued") === expected.enqueued &&
        accepted.headers.get("x-webhook-duplicates") === expected.duplicates,
      `Entrega assinada ${delivery} não comprovou enfileiramento/deduplicação.`
    );
  }

  const invalidSignature = await fetchWithTimeout(`${apiUrl}/webhooks/meta`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=invalid"
    },
    body
  });
  assert(invalidSignature.status === 401, `Assinatura inválida deveria retornar HTTP 401, recebeu ${invalidSignature.status}.`);
  console.log("PASS signed webhook enqueue, deduplication, and signature rejection");

  const web = await fetchWithTimeout(webUrl);
  const html = await web.text();
  assert(web.status === 200, `A interface web retornou HTTP ${web.status}.`);
  assert(web.headers.get("content-type")?.includes("text/html"), "A interface web não retornou HTML.");
  assert(html.includes('id="root"') && html.includes("/src/main.tsx"), "A página do Vite não contém o ponto de entrada esperado.");
  console.log("PASS Vite web root");

  const proxiedHealth = await fetchWithTimeout(`${webUrl}/health/live`);
  assert(proxiedHealth.status === 200, `O proxy do Vite para /health/live retornou HTTP ${proxiedHealth.status}.`);
  assert((await readJson(proxiedHealth))?.status === "ok", "O proxy do Vite para /health/live não retornou status ok.");

  const proxiedInfo = await fetchWithTimeout(`${webUrl}/api/v1/system/info`);
  assert(proxiedInfo.status === 200, `O proxy do Vite para /api/v1/system/info retornou HTTP ${proxiedInfo.status}.`);
  assert((await readJson(proxiedInfo))?.version === "0.1.0", "O proxy do Vite para /api/v1/system/info retornou conteúdo inesperado.");
  console.log("PASS Vite API proxies");

  if (infoBody?.localDemoEnabled) await runAttendanceSmoke(apiUrl);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSmoke().catch((error) => {
    console.error(`Smoke test local falhou: ${error.message}`);
    process.exitCode = 1;
  });
}
