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

export interface ChatAddress {
  /** JID exato para envio, leitura e presença. `@lid` não vira `@s.whatsapp.net`. */
  replyJid: string;
  /** Chave estável de opt-out e limite. Telefone quando conhecido; senão `lid:<id>`. */
  contactId: string;
  phone: string | null;
  aliases: string[];
}

function jidUser(jid: string): { user: string; server: string } | undefined {
  const at = jid.indexOf("@");
  if (at <= 0) return undefined;
  const server = jid.slice(at + 1).split(":")[0] ?? "";
  const user = jid.slice(0, at).split(":")[0]?.split("_")[0] ?? "";
  if (!user || !server) return undefined;
  return { user, server };
}

export function phoneFromJid(jid: string): string | undefined {
  const parsed = jidUser(jid);
  if (!parsed || parsed.server === "lid" || parsed.server === "g.us" || parsed.server === "broadcast" || parsed.server === "newsletter") {
    return undefined;
  }
  if (jid.startsWith("status@")) return undefined;
  return digitsPhone(parsed.user);
}

export function chatAddressFromInbound(remoteJid: string, altPhoneJid?: string): ChatAddress | undefined {
  const remote = jidUser(remoteJid.trim());
  if (!remote || remote.server === "g.us" || remote.server === "broadcast" || remote.server === "newsletter") return undefined;
  const server = remote.server === "c.us" ? "s.whatsapp.net" : remote.server;
  if (server !== "lid" && server !== "s.whatsapp.net") return undefined;
  if (server === "s.whatsapp.net" && !digitsPhone(remote.user)) return undefined;
  if (server === "lid" && !/^[1-9]\d{5,24}$/.test(remote.user)) return undefined;
  const replyJid = `${server === "s.whatsapp.net" ? digitsPhone(remote.user) : remote.user}@${server}`;
  const alt = altPhoneJid?.trim()
    ? jidUser(altPhoneJid.includes("@") ? altPhoneJid : `${altPhoneJid}@s.whatsapp.net`)
    : undefined;
  const phoneFromAlt = alt?.server === "s.whatsapp.net" || alt?.server === "c.us" ? digitsPhone(alt.user) : undefined;
  const phone = server === "s.whatsapp.net" ? digitsPhone(remote.user) ?? null : phoneFromAlt ?? null;
  const lidId = server === "lid" ? `lid:${remote.user}` : null;
  const contactId = phone ?? lidId;
  if (!contactId) return undefined;
  const aliases = lidId && phone && lidId !== phone ? [lidId] : [];
  return { replyJid, contactId, phone, aliases };
}

export function destinationJid(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.includes("@")) {
    const address = chatAddressFromInbound(trimmed);
    return address?.replyJid;
  }
  if (trimmed.startsWith("lid:")) {
    const user = trimmed.slice(4);
    return /^[1-9]\d{5,24}$/.test(user) ? `${user}@lid` : undefined;
  }
  const phone = digitsPhone(trimmed);
  return phone ? phoneToJid(phone) : undefined;
}

export function contactIdFrom(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("lid:")) {
    const user = trimmed.slice(4);
    return /^[1-9]\d{5,24}$/.test(user) ? `lid:${user}` : undefined;
  }
  if (trimmed.includes("@")) return chatAddressFromInbound(trimmed)?.contactId;
  return digitsPhone(trimmed);
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
