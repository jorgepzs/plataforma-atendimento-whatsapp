import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { LocalAttendanceService } from "../src/attendance/service.js";
import type { AttendanceSnapshot, AttendanceStateRepository } from "../src/attendance/types.js";
import { MemoryInboundEventStore } from "../src/infra/memory/memory-inbound-event-store.js";
import { SqliteLocalDatabase } from "../src/infra/sqlite/local-database.js";
import { SqliteInboundEventStore } from "../src/infra/sqlite/sqlite-inbound-event-store.js";
import type { NormalizedInboundMessage } from "../src/meta/inbound-message.js";
import { createMetaSignature } from "../src/meta/signature.js";
import type { OutboundTextInput, OutboundTextSendResult, OutboundTextSender } from "../src/ports/outbound-text-sender.js";
import { testConfig } from "./helpers.js";

const phoneNumberId = "123456789012345";
const customer = "5511999990000";
const fixedNow = new Date("2026-10-03T12:30:00.000Z");

class FakeSender implements OutboundTextSender {
  readonly calls: OutboundTextInput[] = [];

  constructor(private readonly result: OutboundTextSendResult = {
    status: "ACCEPTED", providerMessageId: "wamid.fake.123"
  }) {}

  async sendText(input: OutboundTextInput): Promise<OutboundTextSendResult> {
    this.calls.push({ ...input });
    return this.result;
  }
}

function event(options: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    provider: "META_WHATSAPP",
    source: "META_WEBHOOK",
    providerEventId: "wamid.inbound.1",
    providerPhoneNumberId: phoneNumberId,
    consumerPhoneNumber: customer,
    consumerProfileName: "Cliente de teste",
    occurredAt: new Date("2026-10-03T12:00:00.000Z"),
    type: "text",
    text: "oi",
    rawMessage: { type: "text" },
    ...options
  };
}

function serviceWithSender(options: {
  sender?: FakeSender;
  allowedRecipients?: string[];
  configuredPhoneNumberId?: string;
  channelPhoneNumberId?: string;
  maxTotalAttempts?: number;
} = {}) {
  const sender = options.sender ?? new FakeSender();
  const store = new MemoryInboundEventStore();
  let sequence = 0;
  const service = new LocalAttendanceService(store, {
    now: () => new Date(fixedNow),
    createId: () => `outbox-test-${++sequence}`,
    workerIntervalMs: 60_000,
    outbound: {
      enabled: true,
      graphApiVersion: "v24.0",
      phoneNumberId: options.configuredPhoneNumberId ?? phoneNumberId,
      accessToken: "fake-token-not-used-by-transport",
      allowedRecipients: options.allowedRecipients ?? [customer],
      ...(options.maxTotalAttempts !== undefined ? { maxTotalAttempts: options.maxTotalAttempts } : {}),
      sender
    }
  });
  service.bindTestChannel("pizzaria-demo", options.channelPhoneNumberId ?? phoneNumberId);
  return { service, store, sender };
}

describe("outbound response outbox", () => {
  it("refuses real transport with volatile memory persistence", async () => {
    await expect(buildApp({
      config: {
        ...testConfig,
        localDemoEnabled: true,
        whatsappOutboundEnabled: true,
        whatsappOutboundPhoneNumberId: phoneNumberId,
        whatsappOutboundAccessToken: "dummy-never-used",
        whatsappOutboundAllowedRecipients: [customer]
      },
      store: new MemoryInboundEventStore(),
      outboundSender: new FakeSender(),
      logger: false
    })).rejects.toThrow("demo local com SQLite");
  });

  it("wires opt-in local configuration through the signed Meta webhook using only an injected fake transport", async () => {
    const sender = new FakeSender();
    const directory = mkdtempSync(join(tmpdir(), "outbox-app-test-"));
    const filename = join(directory, "attendance.sqlite");
    const database = new SqliteLocalDatabase(filename);
    const store = new SqliteInboundEventStore(database);
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;

    try {
      app = await buildApp({
        config: {
          ...testConfig,
          localDemoEnabled: true,
          localSqlitePath: filename,
          whatsappOutboundEnabled: true,
          whatsappOutboundPhoneNumberId: phoneNumberId,
          whatsappOutboundAccessToken: "dummy-never-used-by-fake",
          whatsappOutboundAllowedRecipients: [customer]
        },
        store,
        localDatabase: database,
        outboundSender: sender,
        logger: false
      });
      await app.ready();
      await app.localAttendanceService!.stopWorker();
      app.localAttendanceService!.bindTestChannel("pizzaria-demo", phoneNumberId);
      expect((await app.inject({ url: "/api/v1/system/info" })).json()).toMatchObject({
        outboundMode: "cloud-api-local-test",
        whatsappOutboundEnabled: true,
        capabilities: expect.arrayContaining(["whatsapp.text.send.local-test"])
      });
      const payload = {
        object: "whatsapp_business_account",
        entry: [{ changes: [{ value: {
          metadata: { phone_number_id: phoneNumberId },
          contacts: [{ wa_id: customer, profile: { name: "Cliente de teste" } }],
          messages: [{
            id: "wamid.signed-inbound.1", from: customer,
            timestamp: String(Math.floor(Date.now() / 1000) - 30),
            type: "text", text: { body: "oi" }
          }]
        } }] }]
      };
      const rawBody = JSON.stringify(payload);
      const accepted = await app.inject({
        method: "POST",
        url: "/webhooks/meta",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": createMetaSignature(Buffer.from(rawBody), testConfig.metaAppSecret!)
        },
        payload: rawBody
      });
      expect(accepted.statusCode).toBe(200);

      await app.localAttendanceService!.processPending();

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0]?.recipient).toBe(customer);
      expect(app.localAttendanceService!.listOutbox("pizzaria-demo")[0]?.status).toBe("ACCEPTED");
    } finally {
      if (app) await app.close();
      else database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sends an eligible real-webhook response once and records provider acceptance", async () => {
    const { service, store, sender } = serviceWithSender();
    await store.enqueue(event());

    await service.processPending();

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toMatchObject({
      recipient: customer,
      body: "Olá! Sou o assistente virtual da Pizzaria Demo. Como posso ajudar?",
      lastInboundAt: new Date("2026-10-03T12:00:00.000Z")
    });
    expect(service.listOutbox("pizzaria-demo")[0]).toMatchObject({
      source: "META_WEBHOOK",
      phoneNumberId,
      status: "ACCEPTED",
      attemptCount: 1,
      providerMessageId: "wamid.fake.123"
    });
    expect(service.getConversation("pizzaria-demo", service.listConversations("pizzaria-demo")[0]!.id)
      .messages.at(-1)?.deliveryStatus).toBe("ACCEPTED");

    await service.processOutbox();
    expect(sender.calls).toHaveLength(1);
  });

  it("enforces and persists the one-attempt cap for the first real local test", async () => {
    class SnapshotRepository implements AttendanceStateRepository {
      snapshot: AttendanceSnapshot | undefined;
      load() { return this.snapshot ? structuredClone(this.snapshot) : undefined; }
      save(snapshot: AttendanceSnapshot) { this.snapshot = structuredClone(snapshot); }
    }

    const repository = new SnapshotRepository();
    const store = new MemoryInboundEventStore();
    const sender = new FakeSender();
    const secondCustomer = "5511999991111";
    let sequence = 0;
    const options = {
      repository,
      now: () => new Date(fixedNow),
      createId: () => `one-shot-${++sequence}`,
      workerIntervalMs: 60_000,
      outbound: {
        enabled: true,
        graphApiVersion: "v24.0",
        phoneNumberId,
        accessToken: "fake-token-not-used-by-transport",
        allowedRecipients: [customer, secondCustomer],
        maxTotalAttempts: 1,
        sender
      }
    } as const;
    const service = new LocalAttendanceService(store, options);
    service.bindTestChannel("pizzaria-demo", phoneNumberId);
    await store.enqueue(event());
    await service.processPending();
    expect(sender.calls).toHaveLength(1);

    const restarted = new LocalAttendanceService(store, options);
    await store.enqueue(event({ providerEventId: "wamid.inbound.second", consumerPhoneNumber: secondCustomer, text: "Oi" }));
    await restarted.processPending();

    expect(sender.calls).toHaveLength(1);
    expect(restarted.listOutbox("pizzaria-demo").filter((entry) => entry.blockedReason === "test_send_limit_reached")).toHaveLength(1);
  });

  it.each([
    {
      name: "local simulator source",
      inbound: event({ source: "LOCAL_SIMULATOR" }),
      setup: {},
      reason: "source_not_meta"
    },
    {
      name: "recipient not allowlisted",
      inbound: event(),
      setup: { allowedRecipients: ["5511888880000"] },
      reason: "recipient_not_allowlisted"
    },
    {
      name: "channel differs from the configured test sender",
      inbound: event({ providerPhoneNumberId: "987654321098765" }),
      setup: { configuredPhoneNumberId: phoneNumberId, channelPhoneNumberId: "987654321098765" },
      reason: "channel_mismatch"
    },
    {
      name: "service window is closed",
      inbound: event({ occurredAt: new Date("2026-10-02T12:30:00.000Z") }),
      setup: {},
      reason: "service_window_expired"
    }
  ])("blocks $name before calling the sender", async ({ inbound, setup, reason }) => {
    const { service, store, sender } = serviceWithSender(setup);
    await store.enqueue(inbound);

    await service.processPending();

    expect(sender.calls).toHaveLength(0);
    expect(service.listOutbox("pizzaria-demo")[0]).toMatchObject({ status: "BLOCKED", blockedReason: reason });
  });

  it("keeps outbound simulated by default, even for a normalized Meta event", async () => {
    const store = new MemoryInboundEventStore();
    let sequence = 0;
    const service = new LocalAttendanceService(store, {
      now: () => new Date(fixedNow),
      createId: () => `default-outbox-${++sequence}`
    });
    service.bindTestChannel("pizzaria-demo", phoneNumberId);
    await store.enqueue(event());

    await service.processPending();

    expect(service.listOutbox("pizzaria-demo")[0]).toMatchObject({
      status: "SIMULATED", attemptCount: 0, resultCode: "outbound_disabled"
    });
  });

  it("does not retry an indeterminate provider result", async () => {
    const sender = new FakeSender({ status: "INDETERMINATE", reason: "timeout" });
    const { service, store } = serviceWithSender({ sender });
    await store.enqueue(event());

    await service.processPending();
    await service.processOutbox();

    expect(sender.calls).toHaveLength(1);
    expect(service.listOutbox("pizzaria-demo")[0]).toMatchObject({
      status: "INDETERMINATE", resultCode: "timeout", attemptCount: 1
    });
  });

  it.each([
    {
      result: { status: "BLOCKED", reason: "service_window_expired" } as const,
      resultCode: "service_window_expired"
    },
    {
      result: { status: "HTTP_ERROR", httpStatus: 429, category: "rate_limited" } as const,
      resultCode: "rate_limited"
    }
  ])("records terminal sender result $result.status without retry", async ({ result, resultCode }) => {
    const sender = new FakeSender(result);
    const { service, store } = serviceWithSender({ sender });
    await store.enqueue(event());

    await service.processPending();
    await service.processOutbox();

    expect(sender.calls).toHaveLength(1);
    expect(service.listOutbox("pizzaria-demo")[0]).toMatchObject({ status: result.status, resultCode, attemptCount: 1 });
  });

  it("recovers a process interrupted after the send started without replaying it", async () => {
    class SnapshotRepository implements AttendanceStateRepository {
      snapshot: AttendanceSnapshot | undefined;
      load() { return this.snapshot ? structuredClone(this.snapshot) : undefined; }
      save(snapshot: AttendanceSnapshot) { this.snapshot = structuredClone(snapshot); }
    }

    const repository = new SnapshotRepository();
    const sourceStore = new MemoryInboundEventStore();
    let sequence = 0;
    const initial = new LocalAttendanceService(sourceStore, {
      repository,
      now: () => new Date(fixedNow),
      createId: () => `crash-test-${++sequence}`
    });
    initial.bindTestChannel("pizzaria-demo", phoneNumberId);
    await sourceStore.enqueue(event());
    await initial.processPending();

    const interrupted = structuredClone(repository.snapshot!);
    const entry = interrupted.outbox[0]!;
    entry.status = "SENDING";
    entry.attemptCount = 1;
    entry.attemptedAt = fixedNow.toISOString();
    const outgoingMessage = interrupted.messages.find((message) => message.id === entry.messageId)!;
    outgoingMessage.deliveryStatus = "SENDING";
    repository.snapshot = interrupted;

    const sender = new FakeSender();
    const restarted = new LocalAttendanceService(new MemoryInboundEventStore(), {
      repository,
      now: () => new Date(fixedNow),
      outbound: {
        enabled: true,
        graphApiVersion: "v24.0",
        phoneNumberId,
        accessToken: "fake-token-not-used-by-transport",
        allowedRecipients: [customer],
        sender
      }
    });

    expect(restarted.listOutbox("pizzaria-demo")[0]).toMatchObject({
      status: "INDETERMINATE", attemptCount: 1, resultCode: "process_restarted_during_send"
    });
    await restarted.processOutbox();
    expect(sender.calls).toHaveLength(0);
  });
});
