import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { verifyMetaSignature } from "../meta/signature.js";
import { MetaWebhookService } from "../services/meta-webhook-service.js";

interface MetaVerificationQuery {
  "hub.mode"?: string;
  "hub.verify_token"?: string;
  "hub.challenge"?: string;
}

type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };

export async function registerMetaWebhookRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service: MetaWebhookService
): Promise<void> {
  app.get<{ Querystring: MetaVerificationQuery }>("/webhooks/meta", async (request, reply) => {
    const mode = request.query["hub.mode"];
    const verifyToken = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];

    if (mode !== "subscribe" || verifyToken !== config.metaVerifyToken || !challenge) {
      return reply.status(403).send({ error: "webhook_verification_failed" });
    }

    return reply.type("text/plain").send(challenge);
  });

  app.post("/webhooks/meta", async (request, reply) => {
    if (config.metaRequireSignature) {
      if (!config.metaAppSecret) {
        request.log.error("META_APP_SECRET não configurado.");
        return reply.status(503).send({ error: "webhook_signature_not_configured" });
      }

      const rawBody = (request as RequestWithRawBody).rawBody;
      const signature = request.headers["x-hub-signature-256"];
      const providedSignature = Array.isArray(signature) ? signature[0] : signature;

      if (!rawBody || !verifyMetaSignature(rawBody, providedSignature, config.metaAppSecret)) {
        return reply.status(401).send({ error: "invalid_webhook_signature" });
      }
    }

    const summary = await service.accept(request.body);
    request.log.info(summary, "Webhook da Meta aceito.");

    if (config.nodeEnv !== "production") {
      reply
        .header("x-webhook-normalized", String(summary.normalized))
        .header("x-webhook-enqueued", String(summary.enqueued))
        .header("x-webhook-duplicates", String(summary.duplicates))
        .header("x-webhook-unknown-channels", String(summary.unknownChannels));
    }

    return reply.status(200).send({ received: true });
  });
}

