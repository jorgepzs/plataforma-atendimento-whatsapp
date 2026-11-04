import { describe, expect, it, vi } from "vitest";
import { OllamaKnowledgeAnswerSelector } from "../src/attendance/knowledge-classifier.js";

const knowledge = [
  { question: "Qual é o horário?", answer: "Atendemos das 9h às 18h." },
  { question: "Qual é o endereço?", answer: "Estamos na Rua Um, 10." }
];

function responseForDecision(decision: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    message: { role: "assistant", content: JSON.stringify(decision) },
    done: true
  }), { status, headers: { "content-type": "application/json" } });
}

describe("OllamaKnowledgeAnswerSelector", () => {
  it("calls only the fixed local endpoint and returns an approved FAQ index", async () => {
    let requestedUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestInit = init;
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseForDecision({ decision: "match", knowledgeIndex: 1 });
    }) as typeof fetch;
    const selector = new OllamaKnowledgeAnswerSelector({ model: "qwen2.5:1.5b", fetcher });

    await expect(selector.selectAnswerIndex({
      businessName: "Barbearia Demo",
      segment: "barbearia",
      customerText: "Onde vocês ficam?",
      knowledge
    })).resolves.toBe(1);

    expect(requestedUrl).toBe("http://127.0.0.1:11434/api/chat");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.redirect).toBe("error");
    expect(requestBody).toMatchObject({ model: "qwen2.5:1.5b", stream: false, keep_alive: "0", options: { temperature: 0 } });
    expect(requestBody?.format).toMatchObject({ type: "object", additionalProperties: false });
    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    expect(messages[1]?.content).toContain("Onde vocês ficam?");
    expect(messages[1]?.content).toContain("Estamos na Rua Um, 10.");
    expect(messages[1]?.content).not.toContain("5511");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns handoff for an unknown question and rejects malformed or inconsistent decisions", async () => {
    for (const decision of [
      { decision: "handoff", knowledgeIndex: -1 },
      { decision: "match", knowledgeIndex: 7 },
      { decision: "handoff", knowledgeIndex: 0 },
      { decision: "match", knowledgeIndex: -1 },
      { decision: "match", knowledgeIndex: 0, answer: "texto inventado" }
    ]) {
      const selector = new OllamaKnowledgeAnswerSelector({
        model: "test-model",
        fetcher: (async () => responseForDecision(decision)) as typeof fetch
      });
      await expect(selector.selectAnswerIndex({ businessName: "Teste", segment: "outro", customerText: "Olá", knowledge }))
        .resolves.toBeNull();
    }
  });

  it("fails closed without retry on HTTP or transport errors", async () => {
    const httpFetcher = vi.fn(async () => new Response("private error", { status: 503 })) as unknown as typeof fetch;
    const httpSelector = new OllamaKnowledgeAnswerSelector({ model: "test-model", fetcher: httpFetcher });
    await expect(httpSelector.selectAnswerIndex({ businessName: "Teste", segment: "outro", customerText: "Oi", knowledge }))
      .resolves.toBeNull();
    expect(httpFetcher).toHaveBeenCalledTimes(1);

    const failedSelector = new OllamaKnowledgeAnswerSelector({
      model: "test-model",
      fetcher: (async () => { throw new Error("private transport detail"); }) as typeof fetch
    });
    await expect(failedSelector.selectAnswerIndex({ businessName: "Teste", segment: "outro", customerText: "Oi", knowledge }))
      .resolves.toBeNull();
  });

  it("aborts on timeout and refuses oversized input before transport", async () => {
    const timeoutFetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
    const timeoutSelector = new OllamaKnowledgeAnswerSelector({ model: "test-model", fetcher: timeoutFetcher, timeoutMs: 100 });
    await expect(timeoutSelector.selectAnswerIndex({ businessName: "Teste", segment: "outro", customerText: "Oi", knowledge }))
      .resolves.toBeNull();
    expect(timeoutFetcher).toHaveBeenCalledTimes(1);

    const oversizedFetcher = vi.fn() as unknown as typeof fetch;
    const oversizedSelector = new OllamaKnowledgeAnswerSelector({ model: "test-model", fetcher: oversizedFetcher });
    await expect(oversizedSelector.selectAnswerIndex({ businessName: "Teste", segment: "outro", customerText: "x".repeat(4_001), knowledge }))
      .resolves.toBeNull();
    expect(oversizedFetcher).not.toHaveBeenCalled();
  });

  it("rejects unsafe model names and oversized generated content", async () => {
    expect(() => new OllamaKnowledgeAnswerSelector({ model: "model name" })).toThrow("Modelo local inválido");

    const oversizedResponse = new Response("x".repeat(16_385), { status: 200 });
    const selector = new OllamaKnowledgeAnswerSelector({
      model: "test-model",
      fetcher: (async () => oversizedResponse) as typeof fetch
    });
    await expect(selector.selectAnswerIndex({ businessName: "Teste", segment: "outro", customerText: "Oi", knowledge }))
      .resolves.toBeNull();
  });
});
