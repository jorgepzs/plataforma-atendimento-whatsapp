import type { WhatsAppConnectionStatus } from "./types.js";

export interface DisconnectDecision {
  action: "reconnect" | "halt";
  status: WhatsAppConnectionStatus;
  reason: string;
}

/**
 * Códigos observados no protocolo Web (Boom statusCode do Baileys):
 * 401 logout, 403 ban, 405 sessão inválida, 406/402 restrição,
 * 408/428 queda, 411 multi-device, 440 outra sessão, 500 sessão corrompida,
 * 503 indisponível, 515 reinício pedido pelo servidor.
 */
export function classifyDisconnect(statusCode: number | undefined, errorText = ""): DisconnectDecision {
  const text = errorText.toLowerCase();
  if (text.includes("banned") || text.includes("forbidden") || statusCode === 403) {
    return { action: "halt", status: "banned", reason: "banned" };
  }
  if (statusCode === 406 || statusCode === 402 || text.includes("restricted")) {
    return { action: "halt", status: "restricted", reason: "restricted" };
  }
  if (statusCode === 440) return { action: "halt", status: "session_replaced", reason: "session_replaced" };
  if (statusCode === 411) return { action: "halt", status: "session_replaced", reason: "multidevice_mismatch" };
  if (statusCode === 401 || statusCode === 405) return { action: "halt", status: "logged_out", reason: "logged_out" };
  if (statusCode === 500) return { action: "halt", status: "logged_out", reason: "bad_session" };
  return {
    action: "reconnect",
    status: "reconnecting",
    reason: statusCode ? `connection_closed_${statusCode}` : "connection_closed"
  };
}

export function disconnectDetails(error: unknown): { statusCode?: number; text: string } {
  if (!error || typeof error !== "object") {
    return { text: error instanceof Error ? error.message : "" };
  }
  const record = error as {
    message?: unknown;
    statusCode?: unknown;
    output?: { statusCode?: unknown; payload?: { message?: unknown; error?: unknown } };
    data?: unknown;
  };
  const outputCode = record.output?.statusCode;
  const statusCode = typeof outputCode === "number"
    ? outputCode
    : typeof record.statusCode === "number"
      ? record.statusCode
      : undefined;
  const parts = [record.message, record.output?.payload?.message, record.output?.payload?.error, record.data]
    .filter((part): part is string => typeof part === "string");
  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    text: parts.join(" ")
  };
}
