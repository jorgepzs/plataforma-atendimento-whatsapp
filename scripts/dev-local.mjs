import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { localSmokeCredentials, runSmoke } from "./smoke-local.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const apiRoot = resolve(projectRoot, "apps/api");
const webRoot = resolve(projectRoot, "apps/web");
const apiTsx = resolve(apiRoot, "node_modules/tsx/package.json");
const viteCli = resolve(webRoot, "node_modules/vite/bin/vite.js");
const apiPort = 3000;
const webPort = 5173;
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const webBaseUrl = `http://127.0.0.1:${webPort}`;
const runSmokeAfterStart = process.argv.includes("--smoke");
const usePostgres = process.argv.includes("--postgres");
const useMemory = process.argv.includes("--memory") || (runSmokeAfterStart && !process.argv.includes("--sqlite"));
const useSqlite = !usePostgres && !useMemory;
const migrateOnly = process.argv.includes("--migrate-only");
const children = [];
let stopping = false;
let shutdownPromise;

function assertInstalledDependencies() {
  const missing = [];
  if (!existsSync(apiTsx)) missing.push("apps/api dependencies");
  if (!existsSync(viteCli)) missing.push("apps/web dependencies");
  if (missing.length > 0) {
    throw new Error(
      `Dependências ausentes (${missing.join(", ")}). Execute "npm run install:all" na raiz do projeto. ` +
        "O launcher não instala pacotes automaticamente."
    );
  }
}

function runTask(name, args, cwd, env = process.env) {
  return new Promise((resolveTask, rejectTask) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit", windowsHide: true });
    children.push(child);
    child.once("error", rejectTask);
    child.once("close", (code, signal) => {
      if (code === 0) resolveTask();
      else rejectTask(new Error(`${name} falhou (código ${code ?? "n/a"}, sinal ${signal ?? "n/a"}).`));
    });
  });
}

function loadPostgresEnvironment() {
  const filename = resolve(projectRoot, ".env.postgres.local");
  if (!existsSync(filename)) throw new Error('Execute "npm run db:setup" para configurar o banco local.');
  const environment = parseEnv(readFileSync(filename, "utf8"));
  const url = new URL(environment.DATABASE_URL ?? "");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1") {
    throw new Error("O ambiente PostgreSQL local deve usar postgresql:// em 127.0.0.1.");
  }
  return environment;
}

function assertPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolveAvailable, rejectUnavailable) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      rejectUnavailable(new Error(`A porta ${host}:${port} não está disponível (${error.code ?? error.message}).`));
    });
    probe.listen(port, host, () => {
      probe.close((error) => (error ? rejectUnavailable(error) : resolveAvailable()));
    });
  });
}

function childIsClosed(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForClose(child, timeoutMs) {
  if (childIsClosed(child) || !child.pid) return Promise.resolve(true);

  return new Promise((resolveClose) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onClose = () => finish(true);
    const finish = (closed) => {
      clearTimeout(timer);
      child.off("close", onClose);
      resolveClose(closed || childIsClosed(child));
    };
    child.once("close", onClose);
  });
}

async function stopChild(child) {
  if (!childIsClosed(child) && child.pid) {
    if (child.connected) {
      try {
        child.send({ type: "shutdown" });
      } catch {
        child.kill("SIGINT");
      }
    } else {
      child.kill("SIGINT");
    }
  }

  if (!(await waitForClose(child, 3_000)) && child.pid) {
    child.kill("SIGKILL");
    await waitForClose(child, 1_000);
  }
}

function shutdown(exitCode, message) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    if (message) console.log(message);
    await Promise.all(children.map(stopChild));
    process.exitCode = exitCode;
  })();
  return shutdownPromise;
}

function startService(name, args, cwd, env, { ipc = false } = {}) {
  console.log(`Iniciando ${name}...`);
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    windowsHide: true
  });
  children.push(child);

  child.on("error", (error) => {
    console.error(`Não foi possível iniciar ${name}: ${error.message}`);
    void shutdown(1, "Encerrando os serviços locais.");
  });

  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${name} encerrou inesperadamente (código ${code ?? "n/a"}, sinal ${signal ?? "n/a"}).`);
    void shutdown(1, "Encerrando o outro serviço local.");
  });

  return child;
}

async function waitForReady(name, url, child, validate) {
  const deadline = Date.now() + 45_000;
  let lastError;

  while (Date.now() < deadline) {
    if (stopping) throw new Error("Inicialização cancelada.");
    if (childIsClosed(child)) throw new Error(`${name} encerrou antes de ficar pronto.`);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await validate(response))) return;
      lastError = new Error(`${name} respondeu HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }

  throw new Error(`${name} não ficou pronto em 45 segundos${lastError ? `: ${lastError.message}` : "."}`);
}

async function main() {
  assertInstalledDependencies();
  if (usePostgres && (process.argv.includes("--memory") || process.argv.includes("--sqlite"))) {
    throw new Error("Escolha um único modo de armazenamento.");
  }
  if (migrateOnly && !usePostgres) throw new Error("Migrações locais exigem --postgres.");
  if (!migrateOnly) await Promise.all([assertPortAvailable(apiPort), assertPortAvailable(webPort)]);

  let postgresEnvironment = {};
  if (usePostgres) {
    await runTask("PostgreSQL local", [resolve(projectRoot, "scripts/postgres-local.mjs"), "start"], projectRoot);
    postgresEnvironment = loadPostgresEnvironment();
  }

  const sqliteFilename = useSqlite
    ? runSmokeAfterStart
      ? resolve(mkdtempSync(resolve(tmpdir(), "atende-sqlite-smoke-")), "attendance.sqlite")
      : resolve(process.env.LOCAL_SQLITE_PATH || resolve(projectRoot, ".data/attendance.sqlite"))
    : "";
  const apiEnv = {
    ...process.env,
    ...postgresEnvironment,
    NODE_ENV: "development",
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    LOG_LEVEL: "info",
    DATABASE_URL: usePostgres ? postgresEnvironment.DATABASE_URL : "",
    LOCAL_SQLITE_PATH: sqliteFilename,
    META_VERIFY_TOKEN: localSmokeCredentials.verifyToken,
    META_APP_SECRET: localSmokeCredentials.appSecret,
    META_REQUIRE_SIGNATURE: "true",
    ENABLE_LOCAL_DEMO: usePostgres ? "false" : "true"
  };
  const webEnv = { ...process.env };

  if (migrateOnly) {
    await runTask("Migração PostgreSQL", ["--import", "tsx", "src/infra/postgres/migrate.ts"], apiRoot, apiEnv);
    return;
  }

  const api = startService("API", ["--import", "tsx", "src/server.ts"], apiRoot, apiEnv, { ipc: true });
  const web = startService(
    "Vite",
    [viteCli, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    webRoot,
    webEnv
  );

  try {
    await Promise.all([
      waitForReady("API", `${apiBaseUrl}/health/ready`, api, async (response) => {
        const body = await response.json().catch(() => undefined);
        return body?.status === "ready";
      }),
      waitForReady("Vite", webBaseUrl, web, async (response) => {
        const html = await response.text();
        return html.includes('id="root"');
      })
    ]);
  } catch (error) {
    console.error(`Ambiente local não iniciou: ${error.message}`);
    await shutdown(1, "Encerrando os serviços locais.");
    return;
  }

  if (runSmokeAfterStart) {
    try {
      await runSmoke({ apiBaseUrl, webBaseUrl, expectedStore: usePostgres ? "postgres" : useSqlite ? "sqlite" : "memory" });
      await shutdown(0, "Smoke test concluído; encerrando API e Vite.");
    } catch (error) {
      console.error(`Smoke test local falhou: ${error.message}`);
      await shutdown(1, "Encerrando API e Vite.");
    }
    return;
  }

  console.log(`Ambiente pronto. API: ${apiBaseUrl} | Interface: ${webBaseUrl}`);
  console.log("Pressione Ctrl+C para encerrar API e Vite.");
  if (usePostgres) console.log('O PostgreSQL permanece ativo; use "npm run db:stop" para pará-lo.');
  if (useSqlite) console.log(`Dados locais persistidos em: ${sqliteFilename}. Não apague esse arquivo para reiniciar o ambiente.`);
}

process.on("SIGINT", () => void shutdown(0, "Encerrando API e Vite..."));
process.on("SIGTERM", () => void shutdown(0, "Encerrando API e Vite..."));

main().catch(async (error) => {
  console.error(`Falha ao preparar o ambiente local: ${error.message}`);
  await shutdown(1);
});
