import path from "node:path";
import type { BaileysLikeSocket, BaileysSocketFactory } from "./baileys-transport.js";
import { openAtomicAuthState } from "./atomic-auth-state.js";
import { bufferJsonCodec } from "./buffer-json.js";
import { createRetryCounterCache, RecentMessageStore } from "./retry-store.js";
import { countSignalPatch, readContactSignalPatch } from "./signal-files.js";
import {
  createBaileysDecryptLogger,
  DecryptFailureLog,
  installSignalConsoleFilter,
  isCorruptSessionError,
  jidFromDecryptKey,
  type SignalLog
} from "./signal-console.js";

export interface BaileysSocketFactoryOptions {
  log?: SignalLog;
  now?: () => number;
}

const openSockets = new Set<() => Promise<void>>();
let signalsBound = false;

function bindSignalFlush(): void {
  if (signalsBound) return;
  signalsBound = true;
  const flush = (): void => {
    void Promise.all([...openSockets].map((run) => run().catch(() => undefined)));
  };
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);
}

const fallbackLog: SignalLog = {
  debug: () => undefined,
  warn: (payload, message) => {
    const jid = typeof payload.jid === "string" ? payload.jid : "sessão";
    const count = typeof payload.count === "number" ? payload.count : 0;
    console.warn(`${message} [${jid} ${count}]`);
  }
};

/**
 * Fábrica real do Baileys. Importada só quando uma sessão vai abrir,
 * para os testes do restante do canal não carregarem o protocolo.
 * O diretório existente (`creds.json` + `session-*.json`) continua válido.
 */
export function createBaileysSocketFactory(options: BaileysSocketFactoryOptions = {}): BaileysSocketFactory {
  const log = options.log ?? fallbackLog;
  const now = options.now ?? (() => Date.now());
  const consoleFilter = installSignalConsoleFilter({ log, now });
  bindSignalFlush();

  return {
    async create(sessionDir: string): Promise<BaileysLikeSocket> {
      const imported = await import("@whiskeysockets/baileys");
      const baileys = imported as unknown as Record<string, unknown> & {
        default?: (config: Record<string, unknown>) => BaileysRawSocket;
        makeWASocket?: (config: Record<string, unknown>) => BaileysRawSocket;
      };
      const makeWASocket = baileys.default ?? baileys.makeWASocket;
      if (!makeWASocket) throw new Error("Baileys não exportou makeWASocket.");
      const useHelpers = baileys as {
        fetchLatestBaileysVersion?: () => Promise<{ version?: [number, number, number] }>;
        Browsers?: { ubuntu?: (browser: string) => [string, string, string] };
        makeCacheableSignalKeyStore?: (keys: unknown, logger: unknown) => SignalKeyStore;
        initAuthCreds?: () => Record<string, unknown>;
        BufferJSON?: { replacer: (key: string, value: unknown) => unknown; reviver: (key: string, value: unknown) => unknown };
        proto?: { Message?: { AppStateSyncKeyData?: { fromObject: (value: unknown) => unknown } } };
      };
      if (!useHelpers.makeCacheableSignalKeyStore || !useHelpers.initAuthCreds) {
        throw new Error("Baileys não exportou o auth state cacheável.");
      }
      const codec = useHelpers.BufferJSON ?? bufferJsonCodec;
      const revive = useHelpers.proto?.Message?.AppStateSyncKeyData?.fromObject;
      const auth = await openAtomicAuthState(sessionDir, {
        codec,
        initCreds: () => useHelpers.initAuthCreds!(),
        ...(revive ? { reviveAppStateKey: (value) => revive(value) } : {})
      });
      const failures = new DecryptFailureLog(now);
      const messages = new RecentMessageStore({
        filePath: path.join(sessionDir, "sent-messages.json"),
        codec,
        now: () => now()
      });
      await messages.load();
      const retryCounters = createRetryCounterCache(60 * 60 * 1000, () => now());
      let keys: SignalKeyStore | undefined;
      const logger = createBaileysDecryptLogger((key, error) => {
        if (!isCorruptSessionError(error)) return;
        const jid = jidFromDecryptKey(key);
        if (jid) consoleFilter.attributeRecent(jid);
        const note = failures.record(jid);
        if (!note.reset || !jid || !keys) return;
        const timer = setTimeout(() => {
          void resetContactSession(sessionDir, jid, keys!, log);
        }, 0);
        timer.unref?.();
      });
      keys = useHelpers.makeCacheableSignalKeyStore(auth.state.keys, logger);
      let version: [number, number, number] | undefined;
      try {
        version = (await useHelpers.fetchLatestBaileysVersion?.())?.version;
      } catch {
        version = undefined;
      }
      const browser = useHelpers.Browsers?.ubuntu?.("Chrome") ?? ["Ubuntu", "Chrome", "22.04.4"];
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: { creds: auth.state.creds, keys },
        printQRInTerminal: false,
        logger,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        browser,
        msgRetryCounterCache: retryCounters,
        maxMsgRetryCount: 5,
        getMessage: async (key: { id?: string | null }) => {
          const found = messages.get(typeof key?.id === "string" ? key.id : undefined);
          return found == null ? undefined : found;
        }
      });
      sock.ev.on("creds.update", () => {
        void auth.saveCreds().catch((error: unknown) => {
          log.warn(
            { detail: error instanceof Error ? error.message : "save_failed" },
            "Falha ao gravar credenciais do WhatsApp."
          );
        });
      });
      sock.ev.on("messages.upsert", (payload: unknown) => {
        const update = payload as { messages?: Array<{ key?: { id?: string; fromMe?: boolean }; message?: unknown }> } | undefined;
        for (const message of update?.messages ?? []) {
          const id = message?.key?.id;
          if (message?.key?.fromMe === true && typeof id === "string" && message.message != null) {
            messages.remember(id, message.message);
          }
        }
      });
      const flush = async (): Promise<void> => {
        await auth.saveCreds().catch(() => undefined);
        await auth.flush();
        await messages.flush();
      };
      openSockets.add(flush);
      return {
        get user() {
          return sock.user ? { ...(sock.user.id ? { id: sock.user.id } : {}) } : undefined;
        },
        ev: sock.ev,
        sendMessage: async (jid, content) => {
          const result = await sock.sendMessage(jid, content);
          const id = result?.key?.id;
          if (typeof id === "string" && result?.message != null) messages.remember(id, result.message);
          return result;
        },
        sendPresenceUpdate: (presence, jid) => sock.sendPresenceUpdate(presence, jid),
        readMessages: (messageKeys) => sock.readMessages(messageKeys),
        logout: () => sock.logout(),
        end: (error) => {
          openSockets.delete(flush);
          sock.end(error);
        },
        flush,
        decryptFailuresLastHour: () => failures.countLastHour()
      };
    }
  };
}

interface SignalKeyStore {
  get: (type: string, ids: string[]) => Promise<Record<string, unknown>>;
  set: (data: Record<string, Record<string, unknown> | undefined>) => Promise<void>;
}

interface BaileysRawSocket {
  user?: { id?: string };
  ev: {
    on(event: string, listener: (payload: unknown) => void): void;
    removeAllListeners?(event?: string): void;
  };
  sendMessage(jid: string, content: Record<string, unknown>): Promise<{ key?: { id?: string }; message?: unknown } | undefined>;
  sendPresenceUpdate(presence: "composing" | "paused", jid: string): Promise<void>;
  readMessages(keys: Array<{ remoteJid: string; id: string; fromMe?: boolean }>): Promise<void>;
  logout(): Promise<void>;
  end(error?: Error): void;
}

async function resetContactSession(
  sessionDir: string,
  jid: string,
  keys: SignalKeyStore,
  log: SignalLog
): Promise<void> {
  const patch = await readContactSignalPatch(sessionDir, jid);
  const removed = countSignalPatch(patch);
  if (!patch || removed === 0) return;
  await keys.set(patch);
  log.warn(
    { jid, removed },
    "Sessão Signal do contato reiniciada após falhas repetidas de descriptografia. O pareamento da conta foi mantido."
  );
}
