import type { BaileysLikeSocket, BaileysSocketFactory } from "./baileys-transport.js";

/**
 * Fábrica real do Baileys. Importada só quando uma sessão vai abrir,
 * para os testes do restante do canal não carregarem o protocolo.
 */
export function createBaileysSocketFactory(): BaileysSocketFactory {
  return {
    async create(sessionDir: string): Promise<BaileysLikeSocket> {
      const imported = await import("@whiskeysockets/baileys");
      const baileys = imported as any;
      const makeWASocket = baileys.default ?? baileys.makeWASocket;
      const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;
      const pinoModule = await import("pino") as unknown as { default?: (options: { level: string }) => unknown };
      const pino = typeof pinoModule.default === "function"
        ? pinoModule.default
        : pinoModule as unknown as (options: { level: string }) => unknown;
      const logger = pino({ level: "silent" });
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      let version: [number, number, number] | undefined;
      try {
        version = (await fetchLatestBaileysVersion())?.version;
      } catch {
        version = undefined;
      }
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        printQRInTerminal: false,
        logger,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        browser: Browsers.ubuntu("Chrome"),
        getMessage: async () => undefined
      });
      sock.ev.on("creds.update", saveCreds);
      return {
        get user() {
          return sock.user;
        },
        ev: sock.ev,
        sendMessage: (jid, content) => sock.sendMessage(jid, content),
        sendPresenceUpdate: (presence, jid) => sock.sendPresenceUpdate(presence, jid),
        readMessages: (keys) => sock.readMessages(keys),
        logout: () => sock.logout(),
        end: (error) => sock.end(error)
      };
    }
  };
}
