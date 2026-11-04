export type WhatsAppMessageCategory = "SERVICE" | "UTILITY" | "AUTHENTICATION" | "MARKETING";

export interface MessageCostPolicyInput {
  category: WhatsAppMessageCategory;
  customerServiceWindowExpiresAt: Date | null;
  now: Date;
  allowPaidMessages: boolean;
  allowProactiveMessages: boolean;
}

export type MessageCostDecision =
  | { allowed: true; reason: "OPEN_SERVICE_WINDOW" | "PAID_MESSAGES_ENABLED" }
  | {
      allowed: false;
      reason: "SERVICE_WINDOW_CLOSED" | "PROACTIVE_MESSAGES_DISABLED" | "PAID_MESSAGES_DISABLED";
    };

export function evaluateMessageCostPolicy(input: MessageCostPolicyInput): MessageCostDecision {
  const windowIsOpen =
    input.customerServiceWindowExpiresAt !== null &&
    input.customerServiceWindowExpiresAt.getTime() > input.now.getTime();

  if (windowIsOpen && (input.category === "SERVICE" || input.category === "UTILITY")) {
    return { allowed: true, reason: "OPEN_SERVICE_WINDOW" };
  }

  if (!input.allowProactiveMessages) {
    return { allowed: false, reason: "PROACTIVE_MESSAGES_DISABLED" };
  }

  if (!input.allowPaidMessages) {
    return {
      allowed: false,
      reason: windowIsOpen ? "PAID_MESSAGES_DISABLED" : "SERVICE_WINDOW_CLOSED"
    };
  }

  return { allowed: true, reason: "PAID_MESSAGES_ENABLED" };
}

