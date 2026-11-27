import type { FastifyInstance } from "fastify";
import type { InboundEventStore } from "../ports/inbound-event-store.js";
import type { RagEmbeddingProvider } from "../rag/types.js";

export interface SystemRagInfo {
  enabled: boolean;
  storage: "sqlite" | "postgres" | "memory";
  embeddingProvider: RagEmbeddingProvider;
  embeddingModel?: string;
}

export async function registerSystemRoutes(
  app: FastifyInstance,
  store: InboundEventStore,
  localDemoEnabled = false,
  localAiEnabled = false,
  whatsappOutboundEnabled = false,
  llm: { provider: "openrouter" | "local"; model: string } | null = null,
  whatsappChannel: { provider: "unofficial_qr" | "meta_cloud" } | null = null,
  rag: SystemRagInfo | null = null,
  postgresAttendanceEnabled = false
): Promise<void> {
  const attendanceActive = localDemoEnabled || Boolean(whatsappChannel) || postgresAttendanceEnabled;
  app.get("/api/v1/system/info", async () => ({
    product: "Plataforma de atendimento por WhatsApp",
    version: "0.1.0",
    phase: postgresAttendanceEnabled
      ? "postgres-attendance"
      : localDemoEnabled
        ? store.kind === "sqlite" ? "local-persistent-attendance" : "local-attendance"
        : whatsappChannel ? "whatsapp-channel" : "foundation",
    localDemoEnabled,
    localAiEnabled,
    eventStore: store.kind,
    whatsappOutboundEnabled,
    whatsappChannelEnabled: Boolean(whatsappChannel),
    attendancePersistence: attendanceActive ? store.kind : null,
    outboundMode: whatsappChannel
      ? whatsappChannel.provider === "meta_cloud" ? "meta-cloud" : "unofficial-qr"
      : whatsappOutboundEnabled ? "cloud-api-local-test" : "simulated",
    llm: llm ? { enabled: true, provider: llm.provider, model: llm.model } : { enabled: false },
    rag: rag
      ? {
          enabled: rag.enabled,
          storage: rag.storage,
          embeddingProvider: rag.embeddingProvider,
          ...(rag.embeddingModel ? { embeddingModel: rag.embeddingModel } : {})
        }
      : { enabled: false },
    capabilities: [
      "meta.webhook.verify",
      "meta.webhook.receive",
      "meta.webhook.deduplicate",
      "conversation.state.validate",
      "message.cost.guard",
      ...(attendanceActive ? ["auth.local.session", "attendance.local.worker", "attendance.human.queue", "tenant.local.configuration"] : []),
      ...(localAiEnabled ? ["assistant.local.knowledge-classification"] : []),
      ...(llm ? ["assistant.llm.gateway"] : []),
      ...(rag?.enabled ? ["assistant.rag.hybrid"] : []),
      ...(whatsappOutboundEnabled ? ["whatsapp.text.send.local-test"] : []),
      ...(whatsappChannel ? [`whatsapp.provider.${whatsappChannel.provider}`] : []),
      ...(attendanceActive && (store.kind === "sqlite" || store.kind === "postgres") ? ["attendance.local.persistence", "attendance.queue.recovery"] : []),
      ...(postgresAttendanceEnabled ? ["attendance.postgres.unified"] : [])
    ]
  }));
}

