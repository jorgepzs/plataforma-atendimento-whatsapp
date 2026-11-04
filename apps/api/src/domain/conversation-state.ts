export const conversationStates = [
  "BOT_ACTIVE",
  "WAITING_HUMAN",
  "HUMAN_ACTIVE",
  "CLOSED"
] as const;

export type ConversationState = (typeof conversationStates)[number];

const allowedTransitions: Record<ConversationState, ReadonlySet<ConversationState>> = {
  BOT_ACTIVE: new Set(["WAITING_HUMAN", "CLOSED"]),
  WAITING_HUMAN: new Set(["BOT_ACTIVE", "HUMAN_ACTIVE", "CLOSED"]),
  HUMAN_ACTIVE: new Set(["BOT_ACTIVE", "CLOSED"]),
  CLOSED: new Set(["BOT_ACTIVE"])
};

export class InvalidConversationTransitionError extends Error {
  constructor(from: ConversationState, to: ConversationState) {
    super(`Transição de conversa inválida: ${from} -> ${to}`);
    this.name = "InvalidConversationTransitionError";
  }
}

export function canTransitionConversation(from: ConversationState, to: ConversationState): boolean {
  return from === to || allowedTransitions[from].has(to);
}

export function assertConversationTransition(from: ConversationState, to: ConversationState): void {
  if (!canTransitionConversation(from, to)) {
    throw new InvalidConversationTransitionError(from, to);
  }
}

