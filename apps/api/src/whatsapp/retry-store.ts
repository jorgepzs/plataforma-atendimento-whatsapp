import { readFile } from "node:fs/promises";
import { writeAtomic } from "./atomic-file.js";
import { bufferJsonCodec, type JsonCodec } from "./buffer-json.js";

export interface RetryCounterCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  del(key: string): void;
  flushAll(): void;
}

interface CacheEntry {
  value: unknown;
  expires: number;
}

/** Cache em memória com TTL. O Baileys 6.7.24 lê `get`/`set`/`del` de forma síncrona. */
export function createRetryCounterCache(ttlMs = 60 * 60 * 1000, now: () => number = Date.now): RetryCounterCache {
  const values = new Map<string, CacheEntry>();
  const live = (key: string): CacheEntry | undefined => {
    const entry = values.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    get<T>(key: string): T | undefined {
      return live(key)?.value as T | undefined;
    },
    set<T>(key: string, value: T): void {
      values.set(key, { value, expires: now() + ttlMs });
    },
    del(key: string): void {
      values.delete(key);
    },
    flushAll(): void {
      values.clear();
    }
  };
}

interface StoredMessage {
  id: string;
  message: unknown;
  at: number;
}

export interface RecentMessageStoreOptions {
  filePath?: string;
  codec?: JsonCodec;
  max?: number;
  now?: () => number;
}

/**
 * Mensagens enviadas recentemente, por id, para o `getMessage` do Baileys.
 * Sem isso o recibo de retry do contato não consegue reenviar o ciphertext.
 */
export class RecentMessageStore {
  private readonly items: StoredMessage[] = [];
  private readonly codec: JsonCodec;
  private readonly max: number;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  private queued = false;

  constructor(private readonly options: RecentMessageStoreOptions = {}) {
    this.codec = options.codec ?? bufferJsonCodec;
    this.max = options.max ?? 200;
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (!this.options.filePath) return;
    let raw: string;
    try {
      raw = await readFile(this.options.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw, this.codec.reviver);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    this.items.length = 0;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Partial<StoredMessage>;
      if (typeof record.id !== "string" || !record.id || record.message == null) continue;
      this.items.push({ id: record.id, message: record.message, at: typeof record.at === "number" ? record.at : 0 });
    }
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  remember(id: string, message: unknown): void {
    if (!id || message == null) return;
    const existing = this.items.findIndex((item) => item.id === id);
    if (existing >= 0) this.items.splice(existing, 1);
    this.items.push({ id, message, at: this.now() });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    this.schedule();
  }

  get(id: string | undefined): unknown | undefined {
    if (!id) return undefined;
    return this.items.find((item) => item.id === id)?.message;
  }

  async flush(): Promise<void> {
    await this.persist();
    await this.chain;
  }

  private schedule(): void {
    if (!this.options.filePath || this.queued) return;
    this.queued = true;
    this.chain = this.chain.then(async () => {
      this.queued = false;
      await this.persist();
    }).catch(() => {
      this.queued = false;
    });
  }

  private async persist(): Promise<void> {
    if (!this.options.filePath) return;
    await writeAtomic(this.options.filePath, JSON.stringify(this.items, this.codec.replacer));
  }
}
