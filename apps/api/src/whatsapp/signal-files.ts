import { readdir } from "node:fs/promises";

export interface SignalJid {
  user: string;
  server: string;
}

export function parseSignalJid(jid: string): SignalJid | undefined {
  const trimmed = jid.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0) return undefined;
  const server = trimmed.slice(at + 1).split(":")[0] ?? "";
  const user = trimmed.slice(0, at).split(":")[0]?.split("_")[0] ?? "";
  if (!user || !server || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(user)) return undefined;
  return { user, server };
}

/** Mesma normalização de nome do `useMultiFileAuthState` do Baileys. */
export function signalFileName(name: string): string {
  return name.replace(/\//g, "__").replace(/:/g, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ids de `session` e `sender-key` de um contato. `creds.json` e pre-keys ficam de fora:
 * apagar a sessão do contato força um pre-key novo sem desparear a conta.
 */
export function contactSignalPatch(fileNames: readonly string[], jid: string): Record<string, Record<string, null>> | undefined {
  const parsed = parseSignalJid(jid);
  if (!parsed) return undefined;
  const sessions: Record<string, null> = {};
  const senderKeys: Record<string, null> = {};
  const sessionFile = new RegExp(`^session-${escapeRegExp(parsed.user)}\\.(\\d+)\\.json$`);
  const groupPrefix = `${parsed.user}@${parsed.server}::`;

  for (const file of fileNames) {
    if (parsed.server !== "g.us") {
      const match = sessionFile.exec(file);
      const device = match?.[1];
      if (device) {
        sessions[`${parsed.user}.${device}`] = null;
        continue;
      }
    }
    if (!file.startsWith("sender-key-") || !file.endsWith(".json")) continue;
    const encoded = file.slice("sender-key-".length, -".json".length);
    const id = encoded.replace(/__/g, "/").replace(/--/g, "::");
    const matchesGroup = parsed.server === "g.us" && (id.startsWith(groupPrefix) || id.startsWith(`${jid.trim()}::`));
    const matchesUser = parsed.server !== "g.us" && id.includes(`::${parsed.user}::`);
    if (matchesGroup || matchesUser) senderKeys[id] = null;
  }

  const patch: Record<string, Record<string, null>> = {};
  if (Object.keys(sessions).length > 0) patch.session = sessions;
  if (Object.keys(senderKeys).length > 0) patch["sender-key"] = senderKeys;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export async function readContactSignalPatch(folder: string, jid: string): Promise<Record<string, Record<string, null>> | undefined> {
  let names: string[] = [];
  try {
    names = await readdir(folder);
  } catch {
    return undefined;
  }
  return contactSignalPatch(names, jid);
}

export function countSignalPatch(patch: Record<string, Record<string, null>> | undefined): number {
  if (!patch) return 0;
  return Object.values(patch).reduce((total, group) => total + Object.keys(group).length, 0);
}
