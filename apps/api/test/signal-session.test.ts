import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAtomic } from "../src/whatsapp/atomic-file.js";
import { openAtomicAuthState, SessionCredsError } from "../src/whatsapp/atomic-auth-state.js";
import { bufferJsonCodec } from "../src/whatsapp/buffer-json.js";
import { createRetryCounterCache, RecentMessageStore } from "../src/whatsapp/retry-store.js";
import { contactSignalPatch } from "../src/whatsapp/signal-files.js";
import {
  DecryptFailureLog,
  installSignalConsoleFilter,
  isCorruptSessionError,
  isLibsignalDecryptNoise
} from "../src/whatsapp/signal-console.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "wa-signal-"));
  directories.push(directory);
  return directory;
}

describe("atomic session files", () => {
  it("keeps the previous file when the replace does not finish", async () => {
    const file = path.join(tempDir(), "creds.json");
    writeFileSync(file, "KEEP");
    await expect(writeAtomic(file, "NEW", {
      beforeRename: () => {
        throw new Error("boom");
      }
    })).rejects.toThrow("boom");
    expect(readFileSync(file, "utf8")).toBe("KEEP");
    expect(readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("retries a replace that Windows reports as busy", async () => {
    const file = path.join(tempDir(), "session-1.0.json");
    writeFileSync(file, "old");
    let calls = 0;
    await writeAtomic(file, "new", {
      rename: async (from, to) => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        await rename(from, to);
      }
    });
    expect(calls).toBe(2);
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it("reopens an existing Baileys session without minting new credentials", async () => {
    const folder = tempDir();
    const creds = {
      registrationId: 4242,
      me: { id: "5511999990000:17@s.whatsapp.net" },
      noiseKey: { public: Buffer.from("pub"), private: Buffer.from("priv") }
    };
    await writeFile(path.join(folder, "creds.json"), JSON.stringify(creds, bufferJsonCodec.replacer));
    await writeFile(
      path.join(folder, "session-5511999990000.0.json"),
      JSON.stringify(Buffer.from("session-v1"), bufferJsonCodec.replacer)
    );
    const auth = await openAtomicAuthState(folder, { initCreds: () => ({ registrationId: 1 }) });
    expect(auth.state.creds.registrationId).toBe(4242);
    const loaded = await auth.state.keys.get("session", ["5511999990000.0"]);
    expect(Buffer.from(loaded["5511999990000.0"] as Uint8Array).toString()).toBe("session-v1");
    await auth.saveCreds();
    await auth.flush();
    const reopened = await openAtomicAuthState(folder, { initCreds: () => ({ registrationId: 1 }) });
    expect(reopened.state.creds.registrationId).toBe(4242);
    expect(JSON.stringify(reopened.state.creds)).not.toContain("\"registrationId\":1");
  });

  it("preserves an unreadable creds.json instead of pairing again", async () => {
    const folder = tempDir();
    const credsPath = path.join(folder, "creds.json");
    await writeFile(credsPath, "{");
    await expect(openAtomicAuthState(folder, { initCreds: () => ({ registrationId: 1 }) })).rejects.toBeInstanceOf(SessionCredsError);
    expect(readFileSync(credsPath, "utf8")).toBe("{");
  });

  it("quarantines one corrupt session file and leaves the account paired", async () => {
    const folder = tempDir();
    await writeFile(path.join(folder, "creds.json"), JSON.stringify({ registrationId: 4242 }));
    await writeFile(path.join(folder, "session-5511999990000.0.json"), "{");
    const auth = await openAtomicAuthState(folder, { initCreds: () => ({ registrationId: 1 }) });
    const loaded = await auth.state.keys.get("session", ["5511999990000.0"]);
    expect(loaded["5511999990000.0"]).toBeNull();
    expect(readFileSync(path.join(folder, "creds.json"), "utf8")).toContain("4242");
    expect(readdirSync(folder).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("serializes writes so the session file stays valid JSON", async () => {
    const folder = tempDir();
    const auth = await openAtomicAuthState(folder, { initCreds: () => ({ registrationId: 7 }) });
    await Promise.all([
      auth.state.keys.set({ session: { "5511999990000.0": Buffer.from("aaa") } }),
      auth.state.keys.set({ session: { "5511999990000.0": Buffer.from("bbb") } })
    ]);
    const raw = readFileSync(path.join(folder, "session-5511999990000.0.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const loaded = await auth.state.keys.get("session", ["5511999990000.0"]);
    expect(["aaa", "bbb"]).toContain(Buffer.from(loaded["5511999990000.0"] as Uint8Array).toString());
    expect(readdirSync(folder).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("drops only the contact session and keeps the pairing", async () => {
    const folder = tempDir();
    const auth = await openAtomicAuthState(folder, { initCreds: () => ({ registrationId: 4242 }) });
    await auth.saveCreds();
    await auth.state.keys.set({
      session: {
        "5511999990000.0": Buffer.from("bad"),
        "5511888880000.0": Buffer.from("other")
      },
      "sender-key": {
        "120363@g.us::5511999990000::0": Buffer.from("group"),
        "120363@g.us::5511888880000::0": Buffer.from("else")
      },
      "pre-key": { "1": Buffer.from("pre") }
    });
    expect(await auth.forgetContact("5511999990000@s.whatsapp.net")).toBe(2);
    const sessions = await auth.state.keys.get("session", ["5511999990000.0", "5511888880000.0"]);
    expect(sessions["5511999990000.0"]).toBeNull();
    expect(Buffer.from(sessions["5511888880000.0"] as Uint8Array).toString()).toBe("other");
    const senderKeys = await auth.state.keys.get("sender-key", [
      "120363@g.us::5511999990000::0",
      "120363@g.us::5511888880000::0"
    ]);
    expect(senderKeys["120363@g.us::5511999990000::0"]).toBeNull();
    expect(Buffer.from(senderKeys["120363@g.us::5511888880000::0"] as Uint8Array).toString()).toBe("else");
    expect(readFileSync(path.join(folder, "pre-key-1.json"), "utf8")).toContain("Buffer");
    expect(JSON.parse(readFileSync(path.join(folder, "creds.json"), "utf8")).registrationId).toBe(4242);
  });
});

describe("contact session selection", () => {
  it("matches the phone and the group sender key without touching creds", () => {
    const files = [
      "creds.json",
      "pre-key-1.json",
      "session-5511999990000.0.json",
      "session-5511888880000.0.json",
      "sender-key-120363@g.us--5511999990000--0.json"
    ];
    expect(contactSignalPatch(files, "5511999990000:17@s.whatsapp.net")).toEqual({
      session: { "5511999990000.0": null },
      "sender-key": { "120363@g.us::5511999990000::0": null }
    });
    expect(contactSignalPatch(files, "120363@g.us")).toEqual({
      "sender-key": { "120363@g.us::5511999990000::0": null }
    });
    expect(contactSignalPatch(files, "5511777770000@s.whatsapp.net")).toBeUndefined();
  });
});

describe("retry store", () => {
  it("answers a retry by id and reloads buffers after restart", async () => {
    const file = path.join(tempDir(), "sent-messages.json");
    const store = new RecentMessageStore({ filePath: file, max: 2, now: () => 10 });
    store.remember("a", { conversation: "um" });
    store.remember("b", { conversation: "dois", image: Buffer.from("img") });
    store.remember("c", { conversation: "tres" });
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toMatchObject({ conversation: "dois" });
    expect(store.get(undefined)).toBeUndefined();
    await store.flush();
    const reloaded = new RecentMessageStore({ filePath: file, max: 2 });
    await reloaded.load();
    const message = reloaded.get("b") as { image?: Uint8Array };
    expect(Buffer.from(message.image ?? []).toString()).toBe("img");
    expect(reloaded.get("c")).toMatchObject({ conversation: "tres" });
  });

  it("expires retry counters", () => {
    let now = 0;
    const cache = createRetryCounterCache(1_000, () => now);
    cache.set("msg:user", 1);
    expect(cache.get<number>("msg:user")).toBe(1);
    now = 1_000;
    expect(cache.get("msg:user")).toBeUndefined();
    cache.set("msg:other", 2);
    cache.del("msg:other");
    expect(cache.get("msg:other")).toBeUndefined();
    cache.set("msg:left", 3);
    cache.flushAll();
    expect(cache.get("msg:left")).toBeUndefined();
  });
});

describe("libsignal console filter", () => {
  it("keeps unrelated errors and emits one rate-limited line per contact", () => {
    const printed: string[] = [];
    const warnings: string[] = [];
    const debugs: string[] = [];
    const pending: Array<() => void> = [];
    let now = 1_000_000;
    const originalError = console.error;
    const originalLog = console.log;
    console.error = ((...args: unknown[]) => {
      printed.push(args.map((part) => String(part)).join(" "));
    }) as typeof console.error;
    console.log = ((...args: unknown[]) => {
      printed.push(args.map((part) => String(part)).join(" "));
    }) as typeof console.log;
    const filter = installSignalConsoleFilter({
      log: {
        debug: (_payload, message) => debugs.push(message),
        warn: (_payload, message) => warnings.push(message)
      },
      now: () => now,
      schedule: (fn) => pending.push(fn)
    });
    try {
      console.error("Failed to decrypt message with any known session...");
      console.error(
        "Session error:Error: Bad MAC Error: Bad MAC",
        "at Object.verifyMAC (node_modules/libsignal/src/crypto.js:87:15)\n    at SessionCipher.decryptWithSessions (libsignal/src/session_cipher.js:147:29)"
      );
      console.log("database exploded");
      filter.attributeRecent("5511999990000@s.whatsapp.net");
      expect(printed).toEqual(["database exploded"]);
      expect(debugs).toHaveLength(1);
      expect(pending).toHaveLength(1);
      pending[0]?.();
      expect(warnings).toEqual([
        "Falha ao descriptografar mensagem WhatsApp de 5511999990000@s.whatsapp.net: 1 na última hora."
      ]);
      now += 1_000;
      console.error("Failed to decrypt message with any known session... 5511999990000@s.whatsapp.net");
      expect(pending).toHaveLength(1);
      now += 60_000;
      console.error("Failed to decrypt message with any known session... 5511999990000@s.whatsapp.net");
      expect(pending).toHaveLength(2);
      expect(filter.failuresLastHour()).toBe(3);
      expect(isLibsignalDecryptNoise(["database exploded"])).toBe(false);
    } finally {
      filter.restore();
      console.error = originalError;
      console.log = originalLog;
    }
  });

  it("resets a contact only after repeated corrupt-session errors", () => {
    let now = 5_000;
    const log = new DecryptFailureLog(() => now);
    const notes = Array.from({ length: 5 }, () => log.record("5511999990000@s.whatsapp.net"));
    expect(notes.filter((note) => note.reset)).toHaveLength(1);
    expect(log.countLastHour()).toBe(5);
    expect(log.record("5511999990000@s.whatsapp.net").reset).toBe(false);
    now += 10 * 60 * 1000;
    expect(log.record("5511999990000@lid").reset).toBe(false);
    expect(isCorruptSessionError(new Error("No matching sessions found for message"))).toBe(true);
    expect(isCorruptSessionError(new Error("Bad MAC"))).toBe(true);
    expect(isCorruptSessionError(new Error("Key used already or never filled"))).toBe(false);
    expect(isCorruptSessionError(new Error("No session record"))).toBe(false);
  });
});
