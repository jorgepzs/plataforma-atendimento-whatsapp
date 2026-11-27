import { randomBytes } from "node:crypto";
import { mkdir, open, rename as renameFile, unlink } from "node:fs/promises";
import path from "node:path";

const retryable = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface AtomicWriteOptions {
  beforeRename?: () => void;
  rename?: (from: string, to: string) => Promise<void>;
  now?: () => number;
}

/**
 * Grava um arquivo temporário no mesmo diretório e só então troca o destino.
 * Um crash no meio deixa o arquivo anterior intacto — no Windows o `writeFile`
 * direto pode truncar a sessão Signal e produzir Bad MAC depois do restart.
 */
export async function writeAtomic(filePath: string, contents: string, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  const rename = options.rename ?? renameFile;
  const now = options.now ?? Date.now;
  try {
    options.beforeRename?.();
    const deadline = now() + 2_000;
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await rename(temporary, filePath);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code && retryable.has(code) && attempt < 39 && now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        break;
      }
    }
    throw lastError;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
