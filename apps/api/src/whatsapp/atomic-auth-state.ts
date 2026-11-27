import { readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./atomic-file.js";
import { bufferJsonCodec, type JsonCodec } from "./buffer-json.js";
import { countSignalPatch, readContactSignalPatch, signalFileName } from "./signal-files.js";

export class SessionCredsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCredsError";
  }
}

export interface AtomicAuthState {
  state: {
    creds: Record<string, unknown>;
    keys: {
      get: (type: string, ids: string[]) => Promise<Record<string, unknown>>;
      set: (data: Record<string, Record<string, unknown> | undefined>) => Promise<void>;
    };
  };
  saveCreds: () => Promise<void>;
  flush: () => Promise<void>;
  /** Remove só a sessão Signal daquele contato. Não mexe em `creds.json`. */
  forgetContact: (jid: string) => Promise<number>;
}

export interface OpenAtomicAuthOptions {
  codec?: JsonCodec;
  initCreds: () => Record<string, unknown>;
  reviveAppStateKey?: (value: unknown) => unknown;
  now?: () => number;
}

/**
 * Auth state no mesmo layout de arquivos do Baileys (`creds.json`, `session-<id>.json`),
 * com escrita atômica e uma fila por arquivo. Uma sessão já pareada abre sem QR novo.
 */
export async function openAtomicAuthState(folder: string, options: OpenAtomicAuthOptions): Promise<AtomicAuthState> {
  const codec = options.codec ?? bufferJsonCodec;
  const now = options.now ?? Date.now;
  await sweepStaleTemps(folder, now());
  const credsPath = path.join(folder, "creds.json");
  const creds = await readCreds(credsPath, codec, options.initCreds);
  const tails = new Map<string, Promise<unknown>>();
  let inFlight = 0;
  let idleResolve: (() => void) | undefined;
  let idle = Promise.resolve();

  function track<T>(work: Promise<T>): Promise<T> {
    inFlight += 1;
    let resolveIdle: () => void = () => undefined;
    idle = new Promise((resolve) => {
      resolveIdle = resolve;
    });
    idleResolve = resolveIdle;
    void work.finally(() => {
      inFlight -= 1;
      if (inFlight === 0) idleResolve?.();
    });
    return work;
  }

  function exclusive<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(file) ?? Promise.resolve();
    const run = track(previous.then(fn, fn));
    tails.set(file, run.then(() => undefined, () => undefined));
    return run;
  }

  async function readKey(file: string, type: string): Promise<unknown> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      let value = JSON.parse(raw, codec.reviver) as unknown;
      if (type === "app-state-sync-key" && value != null && options.reviveAppStateKey) {
        value = options.reviveAppStateKey(value);
      }
      return value;
    } catch {
      await rename(file, `${file}.corrupt-${now()}`).catch(() => undefined);
      return null;
    }
  }

  const state = {
    creds,
    keys: {
      async get(type: string, ids: string[]): Promise<Record<string, unknown>> {
        const data: Record<string, unknown> = {};
        await Promise.all(ids.map(async (id) => {
          const file = path.join(folder, signalFileName(`${type}-${id}.json`));
          data[id] = await exclusive(file, () => readKey(file, type));
        }));
        return data;
      },
      async set(data: Record<string, Record<string, unknown> | undefined>): Promise<void> {
        const tasks: Promise<void>[] = [];
        for (const category of Object.keys(data)) {
          const group = data[category];
          if (!group) continue;
          for (const id of Object.keys(group)) {
            const value = group[id];
            const file = path.join(folder, signalFileName(`${category}-${id}.json`));
            tasks.push(exclusive(file, async () => {
              if (value == null) {
                await unlink(file).catch((error: NodeJS.ErrnoException) => {
                  if (error.code !== "ENOENT") throw error;
                });
                return;
              }
              await writeAtomic(file, JSON.stringify(value, codec.replacer));
            }));
          }
        }
        await Promise.all(tasks);
      }
    }
  };

  const saveCreds = () => exclusive(credsPath, () => writeAtomic(credsPath, JSON.stringify(creds, codec.replacer)));

  return {
    state,
    saveCreds,
    async flush() {
      for (let attempt = 0; attempt < 8 && inFlight > 0; attempt += 1) {
        await idle;
      }
    },
    async forgetContact(jid: string) {
      const patch = await readContactSignalPatch(folder, jid);
      const removed = countSignalPatch(patch);
      if (patch) await state.keys.set(patch);
      return removed;
    }
  };
}

async function readCreds(credsPath: string, codec: JsonCodec, initCreds: () => Record<string, unknown>): Promise<Record<string, unknown>> {
  let raw: string | undefined;
  try {
    raw = await readFile(credsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initCreds();
    throw error;
  }
  try {
    const parsed = JSON.parse(raw, codec.reviver) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SessionCredsError("creds.json da sessão WhatsApp está ilegível e foi preservado.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SessionCredsError) throw error;
    throw new SessionCredsError("creds.json da sessão WhatsApp está ilegível e foi preservado.");
  }
}

async function sweepStaleTemps(folder: string, nowMs: number): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(names.filter((name) => name.endsWith(".tmp")).map(async (name) => {
    const full = path.join(folder, name);
    try {
      const info = await stat(full);
      if (nowMs - info.mtimeMs > 60_000) await unlink(full);
    } catch {
      // Outro processo pode ter removido o temporário.
    }
  }));
}
