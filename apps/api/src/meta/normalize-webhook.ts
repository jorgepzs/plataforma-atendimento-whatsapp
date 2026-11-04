import { z } from "zod";
import type { InboundMessageType, NormalizedInboundMessage } from "./inbound-message.js";

const contactSchema = z
  .object({
    wa_id: z.string().optional(),
    profile: z.object({ name: z.string().optional() }).passthrough().optional()
  })
  .passthrough();

const messageSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    timestamp: z.string(),
    type: z.string().optional(),
    text: z.object({ body: z.string() }).passthrough().optional(),
    button: z.object({ text: z.string().optional() }).passthrough().optional(),
    interactive: z
      .object({
        type: z.string().optional(),
        button_reply: z.object({ title: z.string().optional() }).passthrough().optional(),
        list_reply: z.object({ title: z.string().optional() }).passthrough().optional()
      })
      .passthrough()
      .optional(),
    image: z.object({ id: z.string().optional() }).passthrough().optional(),
    audio: z.object({ id: z.string().optional() }).passthrough().optional(),
    document: z.object({ id: z.string().optional() }).passthrough().optional(),
    video: z.object({ id: z.string().optional() }).passthrough().optional()
  })
  .passthrough();

const webhookSchema = z
  .object({
    object: z.string().optional(),
    entry: z
      .array(
        z
          .object({
            changes: z
              .array(
                z
                  .object({
                    value: z
                      .object({
                        metadata: z
                          .object({ phone_number_id: z.string().optional() })
                          .passthrough()
                          .optional(),
                        contacts: z.array(contactSchema).optional(),
                        messages: z.array(messageSchema).optional()
                      })
                      .passthrough()
                      .superRefine((value, context) => {
                        if ((value.messages?.length ?? 0) > 0 && !value.metadata?.phone_number_id) {
                          context.addIssue({
                            code: "custom",
                            path: ["metadata", "phone_number_id"],
                            message: "phone_number_id é obrigatório quando o webhook contém mensagens."
                          });
                        }
                      })
                  })
                  .passthrough()
              )
              .optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();

function normalizeMessageType(type: string | undefined): InboundMessageType {
  const supported: ReadonlySet<string> = new Set([
    "text",
    "interactive",
    "button",
    "image",
    "audio",
    "document",
    "video",
    "location",
    "contacts"
  ]);

  return type && supported.has(type) ? (type as InboundMessageType) : "unknown";
}

function extractText(message: z.infer<typeof messageSchema>): string | undefined {
  return (
    message.text?.body ??
    message.button?.text ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title
  );
}

function extractMediaId(message: z.infer<typeof messageSchema>): string | undefined {
  return message.image?.id ?? message.audio?.id ?? message.document?.id ?? message.video?.id;
}

export function normalizeMetaWebhook(payload: unknown): NormalizedInboundMessage[] {
  const envelope = webhookSchema.parse(payload);
  const normalized: NormalizedInboundMessage[] = [];

  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value.metadata?.phone_number_id;
      if (!phoneNumberId) {
        // Status-only and empty callbacks may omit this metadata. Message-bearing
        // changes are rejected by webhookSchema so they cannot be ACKed silently.
        continue;
      }

      for (const message of change.value.messages ?? []) {
        const profileName = change.value.contacts?.find(
          (contact) => contact.wa_id === message.from
        )?.profile?.name;
        const timestamp = Number.parseInt(message.timestamp, 10);
        const text = extractText(message);
        const mediaId = extractMediaId(message);

        normalized.push({
          provider: "META_WHATSAPP",
          source: "META_WEBHOOK",
          providerEventId: message.id,
          providerPhoneNumberId: phoneNumberId,
          consumerPhoneNumber: message.from,
          occurredAt: Number.isFinite(timestamp) ? new Date(timestamp * 1000) : new Date(),
          type: normalizeMessageType(message.type),
          rawMessage: message as Record<string, unknown>,
          ...(profileName ? { consumerProfileName: profileName } : {}),
          ...(text ? { text } : {}),
          ...(mediaId ? { mediaId } : {})
        });
      }
    }
  }

  return normalized;
}

