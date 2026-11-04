import assert from "node:assert/strict";
import { buildApp } from "../apps/api/dist/app.js";
import { loadConfig } from "../apps/api/dist/config.js";
import { MemoryInboundEventStore } from "../apps/api/dist/infra/memory/memory-inbound-event-store.js";

const model = process.env.LOCAL_AI_MODEL || "qwen2.5:1.5b";
const config = loadConfig({
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "3000",
  LOG_LEVEL: "silent",
  META_VERIFY_TOKEN: "local-ai-smoke-verify",
  META_APP_SECRET: "local-ai-smoke-secret",
  META_REQUIRE_SIGNATURE: "true",
  ENABLE_LOCAL_DEMO: "true",
  LOCAL_AI_ENABLED: "true",
  LOCAL_AI_MODEL: model
});
const app = await buildApp({
  config,
  store: new MemoryInboundEventStore(),
  logger: false
});

function assertStatus(response, expected, label) {
  assert.equal(response.statusCode, expected, label + ": resposta HTTP inesperada.");
}

try {
  await app.ready();
  await app.localAttendanceService?.stopWorker();

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "admin@atende.local", password: "AtendeLocal123!" }
  });
  assertStatus(login, 200, "Login sintético");
  const setCookie = login.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  const session = login.json();
  assert.ok(cookie && typeof session.csrfToken === "string", "Sessão local não foi criada.");
  const headers = { cookie, "x-csrf-token": session.csrfToken };

  const tenantId = "pizzaria-demo";
  const current = await app.inject({
    method: "GET",
    url: "/api/v1/tenants/" + tenantId + "/config",
    headers: { cookie }
  });
  assertStatus(current, 200, "Leitura da configuração");
  const { tenant, config: currentConfig } = current.json();
  const approvedAnswer = "Atendemos de terça a domingo, das 11h às 22h.";
  const saveConfig = await app.inject({
    method: "PUT",
    url: "/api/v1/tenants/" + tenantId + "/config",
    headers,
    payload: {
      businessName: tenant.displayName,
      segment: currentConfig.segment,
      greeting: currentConfig.greeting,
      knowledge: [
        { question: "Qual é o horário de funcionamento?", answer: approvedAnswer },
        { question: "Qual é o endereço?", answer: "Estamos na Rua de Teste, 123." }
      ],
      handoffKeywords: ["humano", "atendente"],
      assistantMode: "local_ai",
      version: currentConfig.version
    }
  });
  assertStatus(saveConfig, 200, "Configuração sintética de IA local");

  async function simulateAndInspect(text, customerPhone, clientMessageId) {
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/tenants/" + tenantId + "/simulate",
      headers,
      payload: { customerName: "Cliente sintético", customerPhone, text, clientMessageId }
    });
    assertStatus(accepted, 202, "Mensagem sintética");
    await app.localAttendanceService?.processPending();

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/tenants/" + tenantId + "/conversations",
      headers: { cookie }
    });
    assertStatus(listed, 200, "Listagem sintética");
    const conversation = listed.json().conversations.find((item) => item.customerPhone === customerPhone);
    assert.ok(conversation, "Conversa sintética não encontrada.");

    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/tenants/" + tenantId + "/conversations/" + encodeURIComponent(conversation.id),
      headers: { cookie }
    });
    assertStatus(detail, 200, "Leitura sintética");
    return detail.json();
  }

  const faq = await simulateAndInspect(
    "Até que horas vocês ficam abertos?",
    "5511991999001",
    "ollama-smoke-faq"
  );
  assert.equal(faq.conversation.state, "BOT_ACTIVE", "Pergunta de FAQ não foi respondida automaticamente.");
  assert.equal(faq.messages.at(-1)?.text, approvedAnswer, "O bot não retornou o texto literal da FAQ aprovada.");
  assert.equal(faq.messages.at(-1)?.deliveryStatus, "SIMULATED", "A resposta não permaneceu simulada.");

  const action = await simulateAndInspect(
    "Quero reservar uma mesa para oito pessoas hoje às 20h.",
    "5511991999002",
    "ollama-smoke-reservation"
  );
  assert.equal(action.conversation.state, "WAITING_HUMAN", "Pedido de reserva não foi encaminhado a uma pessoa.");
  assert.equal(action.messages.length, 1, "O sistema gerou resposta automática para um pedido de reserva.");

  console.log("Smoke test local aprovado com " + model + ": FAQ devolveu texto aprovado e reserva foi para atendimento humano. Nenhuma mensagem saiu do ambiente local.");
} catch {
  console.error("Smoke test local de IA falhou. Verifique se o Ollama está ativo em 127.0.0.1:11434 e se o modelo já foi baixado.");
  process.exitCode = 1;
} finally {
  await app.close();
}
