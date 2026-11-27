export interface SignalLog {
  debug(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface DecryptNote {
  jid: string | null;
  counted: boolean;
  countForJid: number;
  consecutive: number;
  totalLastHour: number;
  warn: boolean;
  reset: boolean;
}

const hourMs = 60 * 60 * 1000;
const resetAfter = 5;
const resetCooldownMs = 10 * 60 * 1000;

interface FailureEvent {
  at: number;
  jid: string;
}

/**
 * Conta falhas de MAC por contato e decide quando vale apagar só a sessão dele.
 * O pareamento (creds) não entra nessa conta.
 */
export class DecryptFailureLog {
  private readonly events: FailureEvent[] = [];
  private readonly consecutive = new Map<string, number>();
  private readonly lastWarn = new Map<string, number>();
  private readonly resetAt = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly warnEveryMs = 60_000
  ) {}

  record(jid: string | null, coalesceMs = 0): DecryptNote {
    const at = this.now();
    this.prune(at);
    const label = jid ?? "desconhecido";
    if (!jid && coalesceMs > 0) {
      const last = this.events[this.events.length - 1];
      if (last && last.jid === "desconhecido" && at - last.at < coalesceMs) {
        return this.note(null, false, 0, this.events.length, false);
      }
    }
    if (jid && coalesceMs > 0) {
      const last = this.events[this.events.length - 1];
      if (last && last.jid === "desconhecido" && at - last.at < coalesceMs) {
        last.jid = jid;
        return this.note(jid, false, this.countFor(jid), this.events.length, false);
      }
    }
    this.events.push({ at, jid: label });
    const streak = jid ? (this.consecutive.get(jid) ?? 0) + 1 : 0;
    if (jid) this.consecutive.set(jid, streak);
    const previousWarn = this.lastWarn.get(label) ?? 0;
    const warn = previousWarn === 0 || at - previousWarn >= this.warnEveryMs;
    if (warn) this.lastWarn.set(label, at);
    const cooling = jid ? this.coolingDown(jid, at) : true;
    const reset = Boolean(jid) && streak >= resetAfter && !cooling;
    if (reset && jid) {
      this.consecutive.set(jid, 0);
      this.resetAt.set(jid, at);
    }
    return this.note(jid, true, streak, this.events.length, warn, reset);
  }

  attributeRecent(jid: string, coalesceMs = 200): void {
    const at = this.now();
    let moved = false;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (!event || at - event.at > coalesceMs) break;
      if (event.jid === "desconhecido") {
        event.jid = jid;
        moved = true;
      }
    }
    if (!moved) return;
    const marked = this.lastWarn.get("desconhecido");
    if (marked === undefined) return;
    const current = this.lastWarn.get(jid);
    if (current === undefined || current < marked) this.lastWarn.set(jid, marked);
  }

  countLastHour(): number {
    this.prune(this.now());
    return this.events.length;
  }

  countFor(jid: string): number {
    this.prune(this.now());
    return this.events.filter((event) => event.jid === jid).length;
  }

  recentKnownJid(): string | null {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const jid = this.events[index]?.jid;
      if (jid && jid !== "desconhecido") return jid;
    }
    return null;
  }

  private coolingDown(jid: string, at: number): boolean {
    const marked = this.resetAt.get(jid);
    return marked !== undefined && at - marked < resetCooldownMs;
  }

  private prune(at: number): void {
    const cutoff = at - hourMs;
    while (this.events.length > 0 && this.events[0]!.at < cutoff) this.events.shift();
  }

  private note(jid: string | null, counted: boolean, consecutive: number, totalLastHour: number, warn: boolean, reset = false): DecryptNote {
    return {
      jid,
      counted,
      countForJid: jid ? this.countFor(jid) : 0,
      consecutive,
      totalLastHour,
      warn,
      reset
    };
  }
}

/** Erro que indica sessão do contato fora de sincronia, não replay nem mensagem ausente. */
export function isCorruptSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  if (message.includes("Key used already") || message.includes("Message absent") || message.includes("No session record")) return false;
  return message.includes("Bad MAC") || message.includes("No matching sessions") || message.includes("Over 2000") || message.includes("Chain closed");
}

export function isLibsignalDecryptNoise(args: unknown[]): boolean {
  const text = args.map(flatten).join("\n");
  if (text.includes("Failed to decrypt message with any known session")) return true;
  const fromLibsignal = text.includes("libsignal") || text.includes("session_cipher") || text.includes("verifyMAC");
  if (text.includes("Session error:") && (text.includes("Bad MAC") || fromLibsignal || text.includes("No matching sessions"))) return true;
  if (fromLibsignal && (text.includes("Bad MAC") || text.includes("Failed to decrypt"))) return true;
  return false;
}

export function jidFromDecryptKey(key: unknown): string | null {
  if (!key || typeof key !== "object") return null;
  const record = key as { participant?: unknown; remoteJid?: unknown };
  const participant = typeof record.participant === "string" ? record.participant : "";
  const remote = typeof record.remoteJid === "string" ? record.remoteJid : "";
  const candidate = participant.includes("@") ? participant : remote;
  return candidate.includes("@") ? candidate : null;
}

function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  if (value == null) return "";
  return String(value);
}

function firstLine(args: unknown[]): string {
  const text = args.map(flatten).join(" ").replace(/\s+/g, " ").trim();
  return text.slice(0, 180);
}

export interface ConsoleFilter {
  restore(): void;
  attributeRecent(jid: string): void;
  failuresLastHour(): number;
}

let installedFilters = 0;
let activeFilter: ConsoleFilter | undefined;

export function installSignalConsoleFilter(options: {
  log: SignalLog;
  now?: () => number;
  schedule?: (fn: () => void) => void;
  warnEveryMs?: number;
}): ConsoleFilter {
  if (activeFilter) {
    installedFilters += 1;
    const shared = activeFilter;
    return {
      restore() {
        installedFilters -= 1;
        if (installedFilters <= 0) shared.restore();
      },
      attributeRecent: (jid) => shared.attributeRecent(jid),
      failuresLastHour: () => shared.failuresLastHour()
    };
  }
  const now = options.now ?? Date.now;
  const logbook = new DecryptFailureLog(now, options.warnEveryMs ?? 60_000);
  const schedule = options.schedule ?? ((fn: () => void) => {
    const timer = setTimeout(fn, 0);
    timer.unref?.();
  });
  const originalError = console.error;
  const originalLog = console.log;

  const handle = (args: unknown[]): void => {
    const jid = extractJid(args.map(flatten).join(" "));
    const note = logbook.record(jid, 80);
    if (!note.counted) return;
    options.log.debug(
      { ...(note.jid ? { jid: note.jid } : {}), count: note.totalLastHour, detail: firstLine(args) },
      "libsignal recusou o MAC da sessão."
    );
    if (!note.warn) return;
    const pendingJid = note.jid;
    schedule(() => {
      const resolved = pendingJid ?? logbook.recentKnownJid() ?? "sessão";
      const count = resolved === "sessão" ? logbook.countLastHour() : logbook.countFor(resolved) || note.totalLastHour;
      options.log.warn(
        { jid: resolved, count, window: "1h" },
        `Falha ao descriptografar mensagem WhatsApp de ${resolved}: ${count} na última hora.`
      );
    });
  };

  console.error = ((...args: unknown[]) => {
    if (isLibsignalDecryptNoise(args)) {
      handle(args);
      return;
    }
    originalError.apply(console, args);
  }) as typeof console.error;
  console.log = ((...args: unknown[]) => {
    if (isLibsignalDecryptNoise(args)) {
      handle(args);
      return;
    }
    originalLog.apply(console, args);
  }) as typeof console.log;

  const created: ConsoleFilter = {
    restore() {
      console.error = originalError;
      console.log = originalLog;
      activeFilter = undefined;
      installedFilters = 0;
    },
    attributeRecent(jid: string) {
      logbook.attributeRecent(jid);
    },
    failuresLastHour() {
      return logbook.countLastHour();
    }
  };
  activeFilter = created;
  installedFilters = 1;
  return created;
}

function extractJid(text: string): string | null {
  const match = text.match(/\b\d[\d:._-]*@(?:s\.whatsapp\.net|lid|g\.us|c\.us)\b/);
  return match?.[0] ?? null;
}

export interface BaileysLikeLogger {
  level: string;
  child(bindings: Record<string, unknown>): BaileysLikeLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Logger do socket: o Baileys segue falando, mas só a falha de decrypt chega na nossa conta. */
export function createBaileysDecryptLogger(onDecrypt: (key: unknown, error: unknown) => void): BaileysLikeLogger {
  const logger: BaileysLikeLogger = {
    level: "silent",
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (obj: unknown, msg?: string) => {
      const text = typeof msg === "string" ? msg : typeof obj === "string" ? obj : "";
      if (text !== "failed to decrypt message") return;
      const record = obj && typeof obj === "object" ? obj as { key?: unknown; err?: unknown } : undefined;
      onDecrypt(record?.key, record?.err);
    }
  };
  return logger;
}
