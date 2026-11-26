import { createHash } from "node:crypto";

const linkPattern = /(?:https?:\/\/|www\.)[^\s]+/gi;

export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function textFingerprint(text: string): string {
  return createHash("sha256").update(normalizeForMatch(text)).digest("hex");
}

export function linkCount(text: string): number {
  return text.match(linkPattern)?.length ?? 0;
}

export function isOptOutMessage(text: string, keywords: readonly string[]): boolean {
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;
  return keywords.some((keyword) => normalizeForMatch(keyword) === normalized);
}

export function splitOutboundText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf(" ")];
    const breakAt = Math.max(...candidates);
    const cut = breakAt > maxChars * 0.4 ? breakAt + 1 : maxChars;
    const piece = rest.slice(0, cut).trim();
    if (!piece) break;
    chunks.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function digitsPhone(value: string): string | undefined {
  const digits = value.replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : undefined;
}

export function phoneToJid(phone: string): string {
  return `${phone}@s.whatsapp.net`;
}

export function phoneFromJid(jid: string): string | undefined {
  if (jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid.startsWith("status@")) {
    return undefined;
  }
  const user = jid.split("@")[0]?.split(":")[0] ?? "";
  return /^[1-9]\d{7,14}$/.test(user) ? user : undefined;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

export function safeTenantId(value: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(value) ? value : undefined;
}

export const optOutConfirmationText =
  "Certo. Parei as mensagens automáticas neste número. Se precisar de uma pessoa, aguarde um atendente.";
