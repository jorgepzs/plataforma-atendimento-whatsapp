import type { FastifyInstance } from "fastify";
import type { InboundEventStore } from "../ports/inbound-event-store.js";

export async function registerSystemRoutes(
  app: FastifyInstance,
  store: InboundEventStore,
  localDemoEnabled = false,
  localAiEnabled = false,
  whatsappOutboundEnabled = false,
  llm: { provider: "openrouter" | "local"; model: string } | null = null,
  whatsappChannel: { provider: "unofficial_qr" | "meta_cloud" } | null = null
): Promise<void> {
  app.get("/api/v1/system/info", async () => ({
    product: "Plataforma de atendimento por WhatsApp",
    version: "0.1.0",
    phase: localDemoEnabled ? store.kind === "sqlite" ? "local-persistent-attendance" : "local-attendance" : whatsappChannel ? "whatsapp-channel" : "foundation",
    localDemoEnabled,
    localAiEnabled,
    eventStore: store.kind,
    whatsappOutboundEnabled,
    whatsappChannelEnabled: Boolean(whatsappChannel),
    attendancePersistence: localDemoEnabled || whatsappChannel ? store.kind === "sqlite" ? "sqlite" : "memory" : null,
    outboundMode: whatsappChannel
      ? whatsappChannel.provider === "meta_cloud" ? "meta-cloud" : "unofficial-qr"
      : whatsappOutboundEnabled ? "cloud-api-local-test" : "simulated",
    llm: llm ? { enabled: true, provider: llm.provider, model: llm.model } : { enabled: false },
    capabilities: [
      "meta.webhook.verify",
      "meta.webhook.receive",
      "meta.webhook.deduplicate",
      "conversation.state.validate",
      "message.cost.guard",
      ...(localDemoEnabled || whatsappChannel ? ["auth.local.session", "attendance.local.worker", "attendance.human.queue", "tenant.local.configuration"] : []),
      ...(localAiEnabled ? ["assistant.local.knowledge-classification"] : []),
      ...(llm ? ["assistant.llm.gateway"] : []),
      ...(whatsappOutboundEnabled ? ["whatsapp.text.send.local-test"] : []),
      ...(whatsappChannel ? [`whatsapp.provider.${whatsappChannel.provider}`] : []),
      ...((localDemoEnabled || whatsappChannel) && store.kind === "sqlite" ? ["attendance.local.persistence", "attendance.queue.recovery"] : [])
    ]
  }));
}

