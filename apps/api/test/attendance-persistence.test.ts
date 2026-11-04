import { describe, expect, it } from "vitest";
import { LocalAttendanceService } from "../src/attendance/service.js";
import type {
  AttendanceSnapshot,
  AttendanceStateRepository,
  PendingInboundEventStore
} from "../src/attendance/types.js";
import type { NormalizedInboundMessage } from "../src/meta/inbound-message.js";

class FakeAttendanceRepository implements AttendanceStateRepository {
  snapshot: AttendanceSnapshot | undefined;
  failNextSave = false;
  saveCalls = 0;

  load(): AttendanceSnapshot | undefined {
    return this.snapshot ? structuredClone(this.snapshot) : undefined;
  }

  save(snapshot: AttendanceSnapshot): void {
    this.saveCalls += 1;
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("Falha simulada ao salvar snapshot.");
    }
    this.snapshot = structuredClone(snapshot);
  }
}

class FakePendingStore implements PendingInboundEventStore {
  readonly pending: NormalizedInboundMessage[];
  readonly acknowledged: string[] = [];
  readonly requeued: string[] = [];
  failNextAcknowledge = false;

  constructor(events: NormalizedInboundMessage[] = []) {
    this.pending = [...events];
  }

  async enqueue(message: NormalizedInboundMessage): Promise<"ENQUEUED" | "DUPLICATE" | "UNKNOWN_CHANNEL"> {
    this.pending.push(message);
    return "ENQUEUED";
  }

  takePending(): NormalizedInboundMessage | undefined {
    return this.pending.shift();
  }

  requeue(message: NormalizedInboundMessage): void {
    this.requeued.push(message.providerEventId);
    this.pending.push(message);
  }

  acknowledge(message: NormalizedInboundMessage): void {
    if (this.failNextAcknowledge) {
      this.failNextAcknowledge = false;
      throw new Error("Falha simulada antes do ACK.");
    }
    this.acknowledged.push(message.providerEventId);
  }
}

function makeIdFactory() {
  let sequence = 0;
  return () => `generated-${++sequence}`;
}

function inbound(
  providerEventId: string,
  text = "oi",
  providerPhoneNumberId = "demo-pizzaria-phone"
): NormalizedInboundMessage {
  return {
    provider: "META_WHATSAPP",
    source: "META_WEBHOOK",
    providerEventId,
    providerPhoneNumberId,
    consumerPhoneNumber: "+5511999990000",
    consumerProfileName: "Cliente persistente",
    occurredAt: new Date("2026-10-03T12:00:00.000Z"),
    type: "text",
    text,
    rawMessage: { source: "test" }
  };
}

function makeService(
  store: PendingInboundEventStore,
  repository: AttendanceStateRepository,
  createId = makeIdFactory()
) {
  return new LocalAttendanceService(store, {
    repository,
    createId,
    now: () => new Date("2026-10-03T12:30:00.000Z"),
    workerIntervalMs: 60_000
  });
}

describe("LocalAttendanceService persistence", () => {
  it("seeds only a new repository and restores tenants, versions, conversation state and history", async () => {
    const repository = new FakeAttendanceRepository();
    const store = new FakePendingStore([inbound("event-persist-1")]);
    const service = makeService(store, repository);

    expect(service.listTenants(["pizzaria-demo", "barbearia-demo"])).toHaveLength(2);
    await service.processPending();
    const conversation = service.listConversations("pizzaria-demo")[0]!;
    expect(conversation.state).toBe("BOT_ACTIVE");

    const initialConfig = service.getConfig("pizzaria-demo").config;
    service.updateConfig("pizzaria-demo", {
      ...initialConfig,
      businessName: "Pizzaria Persistida",
      greeting: "Olá, cliente persistente!"
    });
    service.handoff("pizzaria-demo", conversation.id);
    service.claim("pizzaria-demo", conversation.id, "user-1");
    service.reply("pizzaria-demo", conversation.id, { id: "user-1", displayName: "Ana" }, "Já vou ajudar.");
    service.resume("pizzaria-demo", conversation.id, "user-1");
    service.close("pizzaria-demo", conversation.id, "user-1");
    const createdTenant = service.createTenant({ displayName: "Loja nova", segment: "outro" });

    const restarted = makeService(new FakePendingStore(), repository, makeIdFactory());
    expect(restarted.listTenants(["pizzaria-demo", "barbearia-demo", createdTenant.id])).toHaveLength(3);
    expect(restarted.getConfig("pizzaria-demo")).toMatchObject({
      tenant: { displayName: "Pizzaria Persistida" },
      config: { version: 2, greeting: "Olá, cliente persistente!" }
    });
    expect(restarted.getConfig(createdTenant.id).config.knowledge).toEqual([]);

    const restored = restarted.getConversation("pizzaria-demo", conversation.id);
    expect(restored.conversation.state).toBe("CLOSED");
    expect(restored.messages.map((message) => message.role)).toEqual(["CUSTOMER", "BOT", "ATTENDANT"]);
    expect(restored.messages[2]).toMatchObject({ text: "Já vou ajudar.", authorName: "Ana" });
    expect(repository.snapshot?.processedInboundIds).toContain("pizzaria-demo:META_WHATSAPP:event-persist-1");
  });

  it("reloads a transactionally restored snapshot without saving or reseeding", () => {
    const repository = new FakeAttendanceRepository();
    const service = makeService(new FakePendingStore(), repository);
    const tenant = service.createTenant({ displayName: "Empresa temporária", segment: "outro" });
    const externallyRestored = structuredClone(repository.snapshot)!;
    externallyRestored.tenants = externallyRestored.tenants.filter((entry) => entry.tenant.id !== tenant.id);
    repository.snapshot = externallyRestored;
    const saveCallsBeforeReload = repository.saveCalls;

    service.reloadFromRepository();

    expect(service.listTenants([tenant.id])).toEqual([]);
    expect(service.listTenants(["pizzaria-demo", "barbearia-demo"])).toHaveLength(2);
    expect(repository.saveCalls).toBe(saveCallsBeforeReload);
  });

  it("rolls back in-memory tenant, config, handoff and reply mutations when saving fails", async () => {
    const repository = new FakeAttendanceRepository();
    const store = new FakePendingStore([inbound("event-rollback-1")]);
    const service = makeService(store, repository);
    await service.processPending();
    const conversation = service.listConversations("pizzaria-demo")[0]!;
    const beforeCreate = structuredClone(repository.snapshot);
    repository.failNextSave = true;
    expect(() => service.createTenant({ displayName: "Não salvar", segment: "outro" })).toThrow("Falha simulada");
    expect(service.listTenants(["generated-4"])).toEqual([]);
    expect(repository.snapshot).toEqual(beforeCreate);

    const configBefore = service.getConfig("pizzaria-demo");
    const beforeConfigUpdate = structuredClone(repository.snapshot);
    repository.failNextSave = true;
    expect(() => service.updateConfig("pizzaria-demo", {
      ...configBefore.config,
      businessName: "Não persistida"
    })).toThrow("Falha simulada");
    expect(service.getConfig("pizzaria-demo")).toEqual(configBefore);
    expect(repository.snapshot).toEqual(beforeConfigUpdate);

    const beforeHandoff = structuredClone(repository.snapshot);
    repository.failNextSave = true;
    expect(() => service.handoff("pizzaria-demo", conversation.id)).toThrow("Falha simulada");
    expect(service.getConversation("pizzaria-demo", conversation.id).conversation.state).toBe("BOT_ACTIVE");
    expect(repository.snapshot).toEqual(beforeHandoff);

    service.handoff("pizzaria-demo", conversation.id);
    service.claim("pizzaria-demo", conversation.id, "user-1");
    const beforeReply = service.getConversation("pizzaria-demo", conversation.id);
    repository.failNextSave = true;
    expect(() => service.reply("pizzaria-demo", conversation.id, { id: "user-1", displayName: "Ana" }, "Não enviada"))
      .toThrow("Falha simulada");
    expect(service.getConversation("pizzaria-demo", conversation.id)).toEqual(beforeReply);
  });

  it("requeues when the snapshot save fails and commits the event only on retry", async () => {
    const repository = new FakeAttendanceRepository();
    const event = inbound("event-save-retry-1");
    const store = new FakePendingStore([event]);
    const service = makeService(store, repository);
    const beforeEvent = structuredClone(repository.snapshot);

    repository.failNextSave = true;
    await expect(service.processPending()).rejects.toThrow("Falha simulada");
    expect(store.requeued).toEqual([event.providerEventId]);
    expect(store.acknowledged).toEqual([]);
    expect(repository.snapshot).toEqual(beforeEvent);

    await service.processPending();
    expect(store.pending).toHaveLength(0);
    expect(store.acknowledged).toEqual([event.providerEventId]);
    expect(service.listConversations("pizzaria-demo")).toHaveLength(1);
    expect(service.getConversation("pizzaria-demo", service.listConversations("pizzaria-demo")[0]!.id).messages)
      .toHaveLength(2);
  });

  it("deduplicates a persisted event replayed after snapshot commit but before ACK", async () => {
    const repository = new FakeAttendanceRepository();
    const event = inbound("event-ack-crash-1");
    const store = new FakePendingStore([event]);
    store.failNextAcknowledge = true;
    const firstService = makeService(store, repository);

    await expect(firstService.processPending()).rejects.toThrow("Falha simulada antes do ACK");
    expect(store.requeued).toEqual([event.providerEventId]);
    const firstConversation = firstService.listConversations("pizzaria-demo")[0]!;
    expect(firstService.getConversation("pizzaria-demo", firstConversation.id).messages).toHaveLength(2);

    // Reopening both components models a crash after the attendance save but before ACK.
    const restartedStore = new FakePendingStore([event]);
    const restartedService = makeService(restartedStore, repository);
    await restartedService.processPending();

    expect(restartedStore.acknowledged).toEqual([event.providerEventId]);
    expect(restartedService.listConversations("pizzaria-demo")).toHaveLength(1);
    expect(restartedService.getConversation("pizzaria-demo", firstConversation.id).messages).toHaveLength(2);
  });

  it("waits for an active run and allows shutdown after the run rejects", async () => {
    let releaseRequeue: (() => void) | undefined;
    let requeueStarted: (() => void) | undefined;
    const event = inbound("event-stop-failed-run-1");
    let taken = false;
    const store: PendingInboundEventStore = {
      async enqueue() { return "ENQUEUED"; },
      takePending() {
        if (taken) return undefined;
        taken = true;
        return event;
      },
      requeue() {
        requeueStarted?.();
        return new Promise<void>((_resolve, reject) => {
          releaseRequeue = () => reject(new Error("Falha simulada ao recolocar na fila."));
        });
      }
    };
    const repository = new FakeAttendanceRepository();
    const service = makeService(store, repository);
    repository.failNextSave = true;
    const started = new Promise<void>((resolve) => { requeueStarted = resolve; });
    const run = service.processPending();
    const observedRun = run.catch(() => undefined);
    await started;
    let stopped = false;
    const stopping = service.stopWorker().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseRequeue?.();
    await Promise.all([observedRun, stopping]);
    expect(stopped).toBe(true);
  });
});
