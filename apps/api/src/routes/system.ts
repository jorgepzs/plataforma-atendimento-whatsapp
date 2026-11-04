import type { FastifyInstance } from "fastify";
import type { InboundEventStore } from "../ports/inbound-event-store.js";

export async function registerSystemRoutes(
  app: FastifyInstance,
  store: InboundEventStore,
  localDemoEnabled = false,
  localAiEnabled = false,
  whatsappOutboundEnabled = false
): Promise<void> {
  app.get("/api/v1/system/info", async () => ({
    product: "Plataforma de atendimento por WhatsApp",
    version: "0.1.0",
    phase: localDemoEnabled ? store.kind === "sqlite" ? "local-persistent-attendance" : "local-attendance" : "foundation",
    localDemoEnabled,
    localAiEnabled,
    eventStore: store.kind,
    whatsappOutboundEnabled,
    attendancePersistence: localDemoEnabled ? store.kind === "sqlite" ? "sqlite" : "memory" : null,
    outboundMode: whatsappOutboundEnabled ? "cloud-api-local-test" : "simulated",
    capabilities: [
      "meta.webhook.verify",
      "meta.webhook.receive",
      "meta.webhook.deduplicate",
      "conversation.state.validate",
      "message.cost.guard",
      ...(localDemoEnabled ? ["auth.local.session", "attendance.local.worker", "attendance.human.queue", "tenant.local.configuration"] : []),
      ...(localAiEnabled ? ["assistant.local.knowledge-classification"] : []),
      ...(whatsappOutboundEnabled ? ["whatsapp.text.send.local-test"] : []),
      ...(localDemoEnabled && store.kind === "sqlite" ? ["attendance.local.persistence", "attendance.queue.recovery"] : [])
    ]
  }));
}

