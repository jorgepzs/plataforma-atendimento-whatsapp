import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAttendanceService } from "../src/attendance/service.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { SqliteLocalDatabase } from "../src/infra/sqlite/local-database.js";
import type { LlmAssistant, LlmTurnInput } from "../src/llm/assistant.js";

const orderText = "quero uma calabresa grande para retirada";

let tempDirectory = "";
let database: SqliteLocalDatabase | undefined;

afterEach(() => {
  try { database?.close(); } catch { /* a test may have simulated a restart */ }
  database = undefined;
  if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
  tempDirectory = "";
});

function makeIdFactory(prefix: string) {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function createAssistant(inputs: LlmTurnInput[]): LlmAssistant {
  return {
    failureOutcome: () => ({ kind: "reply", text: "Falha controlada." }),
    async completeTurn(input) {
      inputs.push(input);
      if (input.customerText === orderText && input.session) {
        await input.session.execute("add_item", {
          itemId: "calabresa", quantity: 1, choiceIds: ["calabresa-grande"]
        });
        await input.session.execute("set_fulfillment", { method: "pickup" });
        await input.session.execute("get_order_summary", {});
        return { kind: "reply", text: "O total é R$ 63,00. Responda SIM para confirmar." };
      }
      if (input.customerText === "sim" && input.session) {
        await input.session.execute("confirm_order", {});
        return { kind: "reply", text: "Pedido confirmado." };
      }
      return { kind: "reply", text: "Resposta sem pedido ativo." };
    }
  };
}

function makeService(now: () => Date, inputs: LlmTurnInput[], prefix: string) {
  if (!database) throw new Error("Banco de teste não inicializado.");
  return new LocalAttendanceService(new MemoryInboundEventStore(), {
    repository: database.attendanceRepository,
    llmAssistant: createAssistant(inputs),
    now,
    createId: makeIdFactory(prefix),
    botSessionTtlMs: 60 * 60 * 1_000,
    workerIntervalMs: 60_000
  });
}

async function send(service: LocalAttendanceService, text: string, id: string) {
  await service.simulateMessage("pizzaria-demo", {
    customerName: "Cliente",
    customerPhone: "5511991000088",
    text,
    clientMessageId: id
  });
  await service.processPending();
}

describe("persistência de sessão temporária no SQLite", () => {
  it("restaura sessão ativa, histórico e vínculo do rascunho após reiniciar", async () => {
    tempDirectory = mkdtempSync(path.join(tmpdir(), "bot-session-sqlite-"));
    const filename = path.join(tempDirectory, "attendance.sqlite");
    database = new SqliteLocalDatabase(filename);
    let clock = Date.parse("2026-11-25T12:00:00.000Z");
    const firstInputs: LlmTurnInput[] = [];
    const first = makeService(() => new Date(clock), firstInputs, "before-restart");
    await send(first, orderText, "sqlite-active-1");

    const persisted = database.attendanceRepository.load();
    const originalOrder = persisted?.orders?.[0];
    expect(originalOrder?.status).toBe("awaiting_confirmation");
    expect(persisted?.botSessions).toHaveLength(1);
    expect(persisted?.messages.filter((message) => message.botSessionId)).toHaveLength(2);
    const oldSessionId = persisted?.botSessions?.[0]?.id;
    expect(oldSessionId).toBeTruthy();

    database.close();
    database = new SqliteLocalDatabase(filename);
    const restartedInputs: LlmTurnInput[] = [];
    const restarted = makeService(() => new Date(clock), restartedInputs, "after-restart");
    clock += 1_000;
    await send(restarted, "sim", "sqlite-active-2");

    const continuation = restartedInputs.find((input) => input.customerText === "sim");
    expect(continuation?.order?.id).toBe(originalOrder?.id);
    expect(continuation?.session?.order()?.id).toBe(originalOrder?.id);
    expect(continuation?.history?.map((message) => message.content)).toHaveLength(2);
    expect(continuation?.history?.[0]?.content).toBe(orderText);
    expect(continuation?.history?.[1]?.content).toContain("Resumo do pedido:");
    expect(continuation?.history?.[1]?.content).toContain("Total: R$ 63,00");
    expect(restarted.listOrders("pizzaria-demo").find((order) => order.id === originalOrder?.id)?.status).toBe("confirmed");
    expect(database.attendanceRepository.load()?.botSessions?.[0]?.id).toBe(oldSessionId);
  });

  it("não restaura sessão expirada e mantém o rascunho sem permitir confirmação tardia", async () => {
    tempDirectory = mkdtempSync(path.join(tmpdir(), "bot-session-expired-sqlite-"));
    const filename = path.join(tempDirectory, "attendance.sqlite");
    database = new SqliteLocalDatabase(filename);
    let clock = Date.parse("2026-11-25T12:00:00.000Z");
    const first = makeService(() => new Date(clock), [], "before-expiry");
    await send(first, orderText, "sqlite-expired-1");
    const oldOrder = first.listOrders("pizzaria-demo")[0]!;
    const oldSessionId = database.attendanceRepository.load()?.botSessions?.[0]?.id;
    expect(oldOrder.status).toBe("awaiting_confirmation");
    expect(oldSessionId).toBeTruthy();

    database.close();
    clock += 60 * 60 * 1_000 + 1;
    database = new SqliteLocalDatabase(filename);
    const restartedInputs: LlmTurnInput[] = [];
    const reloaded = makeService(() => new Date(clock), restartedInputs, "after-expiry");
    expect(database.attendanceRepository.load()?.botSessions ?? []).toHaveLength(0);
    await send(reloaded, "sim", "sqlite-expired-2");

    expect(reloaded.listOrders("pizzaria-demo")).toMatchObject([{ id: oldOrder.id, status: "awaiting_confirmation" }]);
    const persisted = database.attendanceRepository.load();
    expect(persisted?.orders?.find((order) => order.id === oldOrder.id)?.status).toBe("awaiting_confirmation");
    expect(persisted?.botSessions?.[0]?.id).not.toBe(oldSessionId);
    const lateConfirmation = restartedInputs.find((input) => input.customerText === "sim");
    expect(lateConfirmation?.order).toBeNull();
    expect(lateConfirmation?.session).toBeUndefined();
  });
});
