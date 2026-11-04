import type { FastifyInstance } from "fastify";
import type { InboundEventStore } from "../ports/inbound-event-store.js";

export async function registerHealthRoutes(
  app: FastifyInstance,
  store: InboundEventStore
): Promise<void> {
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const ready = await store.isReady();
    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      dependencies: {
        eventStore: {
          status: ready ? "up" : "down",
          kind: store.kind
        }
      }
    });
  });
}

