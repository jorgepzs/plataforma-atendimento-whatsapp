import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import path from "node:path";

interface LockRecord {
  pid: number;
  token: string;
}

export class SessionLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLockError";
  }
}

export interface SessionLock {
  release(): void;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLock(lockPath: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      !parsed || typeof parsed !== "object" ||
      !Number.isSafeInteger((parsed as Partial<LockRecord>).pid) ||
      (parsed as Partial<LockRecord>).pid! <= 0 ||
      typeof (parsed as Partial<LockRecord>).token !== "string"
    ) {
      return undefined;
    }
    return parsed as LockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SessionLockError("O lock da sessão WhatsApp está ilegível; ele foi preservado.");
  }
}

/**
 * Uma sessão de número por processo. Outro processo com o mesmo diretório é recusado.
 */
export function acquireDirectoryLock(
  directory: string,
  options: { isAlive?: (pid: number) => boolean } = {}
): SessionLock {
  mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, "session.lock");
  const isAlive = options.isAlive ?? defaultIsAlive;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      const contents = JSON.stringify({ pid: process.pid, token } satisfies LockRecord);
      writeSync(descriptor, contents, 0, "utf8");
      fsyncSync(descriptor);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            const current = readLock(lockPath);
            if (current?.token === token) rmSync(lockPath, { force: true });
          } finally {
            closeSync(descriptor);
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const current = readLock(lockPath);
    if (!current) continue;
    if (isAlive(current.pid)) {
      throw new SessionLockError(`A sessão já está aberta pelo processo ${current.pid}.`);
    }

    const quarantine = `${lockPath}.stale-${token}`;
    try {
      renameSync(lockPath, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    rmSync(quarantine, { force: true });
  }

  throw new SessionLockError("Não foi possível adquirir o lock exclusivo da sessão WhatsApp.");
}
