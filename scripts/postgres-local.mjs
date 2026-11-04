import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const apiRoot = resolve(projectRoot, "apps/api");
const runtimeRoot = resolve(
  process.env.LOCAL_POSTGRES_ROOT || resolve(projectRoot, "work/runtime/postgresql")
);
const binariesDirectory = resolve(
  process.env.LOCAL_POSTGRES_BIN_DIR || resolve(runtimeRoot, "official", "bin")
);
const dataDirectory = resolve(runtimeRoot, "data");
const statePath = resolve(runtimeRoot, "local-state.json");
const appEnvironmentPath = resolve(projectRoot, ".env.postgres.local");
const postgresPath = resolve(binariesDirectory, "postgres.exe");
const psqlPath = resolve(binariesDirectory, "psql.exe");
const initdbPath = resolve(binariesDirectory, "initdb.exe");
const pgCtlPath = resolve(binariesDirectory, "pg_ctl.exe");

const host = "127.0.0.1";
const port = 5432;
const database = "sou_local";
const adminRole = "sou_local_admin";
const appRole = "sou_local";
const seedTenantSlug = "local-demo";
const seedPhoneNumberId = "local-phone-number";

class LocalPostgresError extends Error {}

function usage() {
  console.log(
    [
      "Uso: node scripts/postgres-local.mjs <setup|start|stop|status|seed>",
      "",
      "setup  Inicializa (se necessário), inicia e configura o PostgreSQL local.",
      "start  Inicia o cluster local existente.",
      "stop   Para somente o cluster local deste projeto.",
      "status Mostra se o cluster local está ativo.",
      "seed   Cria o tenant local-demo e o canal local-phone-number após as migrações."
    ].join("\n")
  );
}

function randomPassword() {
  return randomBytes(32).toString("base64url");
}

function equivalentPath(left, right) {
  return resolve(left).replaceAll("/", "\\").toLocaleLowerCase("en-US") ===
    resolve(right).replaceAll("/", "\\").toLocaleLowerCase("en-US");
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function requireBinary(path) {
  if (!(await pathExists(path))) {
    throw new LocalPostgresError(
      `Binário ausente: ${path}. Instale o PostgreSQL local no diretório runtime configurado.`
    );
  }
}

function runExecutable(executable, args, timeoutMs = 180_000) {
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      rejectRun(
        new LocalPostgresError(
          `Não foi possível executar ${basename(executable)} (${error?.code ?? "erro de execução"}).`
        )
      );
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finishReject(new LocalPostgresError(`${basename(executable)} excedeu o tempo limite.`));
    }, timeoutMs);

    function finishReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(error);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      finishReject(
        new LocalPostgresError(
          `Não foi possível executar ${basename(executable)} (${error.code ?? "erro de execução"}).`
        )
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function describeToolFailure(executable, result) {
  const detail = `${result.stdout}\n${result.stderr}`.trim();
  const safeDetail = detail.length > 1_500 ? `${detail.slice(-1_500)}` : detail;
  return new LocalPostgresError(
    `${basename(executable)} falhou (código ${result.code ?? result.signal ?? "desconhecido"})${
      safeDetail ? `: ${safeDetail}` : "."
    }`
  );
}

async function runChecked(executable, args, timeoutMs) {
  const result = await runExecutable(executable, args, timeoutMs);
  if (result.code !== 0) throw describeToolFailure(executable, result);
  return result;
}

async function preflightBinaries() {
  for (const path of [postgresPath, psqlPath, pgCtlPath, initdbPath]) {
    await requireBinary(path);
  }

  const checks = [
    ["postgres", postgresPath],
    ["psql", psqlPath],
    ["pg_ctl", pgCtlPath]
  ];
  const versions = [];
  for (const [name, executable] of checks) {
    let result;
    try {
      result = await runExecutable(executable, ["--version"], 15_000);
    } catch (error) {
      if (name === "pg_ctl" || (error instanceof LocalPostgresError && /EPERM|EACCES|UNKNOWN|bloquead/i.test(error.message))) {
        throw new LocalPostgresError(
          `Preflight de ${name}.exe falhou ao executar (${error.message}). Uma política do Windows, como App Control ou Code Integrity, pode estar impedindo o binário. Nenhum estado, cluster ou arquivo de configuração foi criado.`
        );
      }
      throw error;
    }

    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.code !== 0) {
      if (name === "pg_ctl" || /blocked|block|integrity|controle de aplicativo|administrador/i.test(output)) {
        throw new LocalPostgresError(
          `Preflight de ${name}.exe falhou (código ${result.code ?? result.signal ?? "desconhecido"}). Uma política do Windows, como App Control ou Code Integrity, pode estar impedindo o binário. Nenhum estado, cluster ou arquivo de configuração foi criado.`
        );
      }
      throw new LocalPostgresError(
        `Preflight de ${name}.exe falhou (código ${result.code ?? result.signal ?? "desconhecido"}). Nenhum estado, cluster ou arquivo de configuração foi criado.`
      );
    }
    const version = output.split(/\r?\n/).find((line) => line.trim())?.trim();
    if (!version) {
      throw new LocalPostgresError(
        `Preflight de ${name}.exe não retornou versão. Nenhum estado, cluster ou arquivo de configuração foi criado.`
      );
    }
    versions.push(`${name}: ${version}`);
  }
  console.log(`Preflight PostgreSQL aprovado (${versions.join("; ")}).`);
}

async function isDirectoryInitialized() {
  return pathExists(resolve(dataDirectory, "PG_VERSION"));
}

async function directoryHasEntries(path) {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeNewFile(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(path, mode);
  } catch {
    // Windows ACLs govern access; chmod is best-effort on filesystems that support it.
  }
}

function parseEnvironment(contents) {
  const values = new Map();
  for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

async function readEnvironmentFile() {
  try {
    const contents = await readFile(appEnvironmentPath, "utf8");
    return { exists: true, contents, values: parseEnvironment(contents) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, contents: "", values: new Map() };
    throw error;
  }
}

function parseDatabaseUrl(value) {
  if (!value) {
    throw new LocalPostgresError(
      `${appEnvironmentPath} existe sem DATABASE_URL; o script preserva esse arquivo e não o substituirá.`
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LocalPostgresError(
      `${appEnvironmentPath} contém uma DATABASE_URL inválida; o script preserva esse arquivo.`
    );
  }

  if (!/^postgres(?:ql)?:$/.test(url.protocol)) {
    throw new LocalPostgresError(`${appEnvironmentPath} deve apontar para uma URL PostgreSQL local.`);
  }

  return {
    url,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    db: decodeURIComponent(url.pathname.replace(/^\//, "")),
    host: url.hostname,
    port: Number(url.port || "5432")
  };
}

function assertConfigMatchesState(environment, state) {
  if (!environment.exists) return;
  const parsed = parseDatabaseUrl(environment.values.get("DATABASE_URL"));
  if (
    parsed.user !== appRole ||
    parsed.password !== state.appPassword ||
    parsed.db !== database ||
    parsed.host !== host ||
    parsed.port !== port
  ) {
    throw new LocalPostgresError(
      `${appEnvironmentPath} já existe com credenciais ou destino diferentes. O script preservou o arquivo e não alterou o banco.`
    );
  }
}

function validateState(value) {
  if (
    !value ||
    value.version !== 1 ||
    value.host !== host ||
    value.port !== port ||
    value.database !== database ||
    value.adminRole !== adminRole ||
    value.appRole !== appRole ||
    typeof value.adminPassword !== "string" ||
    value.adminPassword.length < 32 ||
    typeof value.appPassword !== "string" ||
    value.appPassword.length < 32 ||
    typeof value.dataDirectory !== "string" ||
    !isAbsolute(value.dataDirectory) ||
    !equivalentPath(value.dataDirectory, dataDirectory)
  ) {
    throw new LocalPostgresError(
      `${statePath} não corresponde à configuração deste cluster. O script preservou os arquivos existentes.`
    );
  }
  return value;
}

async function readState() {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return validateState(state);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof LocalPostgresError) throw error;
    if (error instanceof SyntaxError) {
      throw new LocalPostgresError(`${statePath} não contém estado JSON válido; o arquivo foi preservado.`);
    }
    throw error;
  }
}

function parseExistingAppPassword(environment) {
  if (!environment.exists) return randomPassword();
  const parsed = parseDatabaseUrl(environment.values.get("DATABASE_URL"));
  if (
    parsed.user !== appRole ||
    parsed.db !== database ||
    parsed.host !== host ||
    parsed.port !== port ||
    parsed.password.length < 32
  ) {
    throw new LocalPostgresError(
      `${appEnvironmentPath} já existe, mas não aponta para o cluster local esperado; o arquivo foi preservado.`
    );
  }
  return parsed.password;
}

async function persistState(state) {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  try {
    await writeNewFile(statePath, content);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readState();
    if (!existing) throw error;
    return existing;
  }
  return state;
}

async function loadOrCreateState({ environment, allowCreate }) {
  const state = await readState();
  if (state) {
    assertConfigMatchesState(environment, state);
    return state;
  }

  if (!allowCreate) {
    throw new LocalPostgresError(
      `Estado local ausente em ${statePath}. Execute "setup" antes desta operação; nenhum cluster foi alterado.`
    );
  }

  if (await isDirectoryInitialized()) {
    throw new LocalPostgresError(
      `O cluster em ${dataDirectory} já contém dados, mas ${statePath} não existe. O script não substituirá credenciais nem inicializará outro cluster.`
    );
  }
  if (await directoryHasEntries(dataDirectory)) {
    throw new LocalPostgresError(
      `O diretório ${dataDirectory} contém arquivos sem um cluster PostgreSQL reconhecível. Ele foi preservado.`
    );
  }

  const created = {
    version: 1,
    host,
    port,
    database,
    adminRole,
    adminPassword: randomPassword(),
    appRole,
    appPassword: parseExistingAppPassword(environment),
    dataDirectory
  };
  const saved = await persistState(created);
  assertConfigMatchesState(environment, saved);
  return saved;
}

function connectionUrl(role, password, db) {
  const encodedUser = encodeURIComponent(role);
  const encodedPassword = encodeURIComponent(password);
  return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${encodeURIComponent(db)}`;
}

function createPgClient(role, password, db) {
  let requireFromApi;
  try {
    requireFromApi = createRequire(resolve(apiRoot, "package.json"));
  } catch {
    throw new LocalPostgresError("Não foi possível resolver as dependências da API em apps/api.");
  }

  let Client;
  try {
    ({ Client } = requireFromApi("pg"));
  } catch {
    throw new LocalPostgresError(
      "Dependência pg ausente em apps/api. Execute npm install --prefix apps/api antes de usar o banco local."
    );
  }

  return new Client({
    connectionString: connectionUrl(role, password, db),
    application_name: "sou-postgres-local",
    connectionTimeoutMillis: 5_000
  });
}

function sanitizedDatabaseFailure(error, action) {
  if (error instanceof LocalPostgresError) return error;
  const code = typeof error?.code === "string" ? error.code : "erro de conexão";
  if (code === "28P01") {
    return new LocalPostgresError(`${action}: autenticação recusada; credenciais locais não foram alteradas.`);
  }
  if (code === "3D000") {
    return new LocalPostgresError(`${action}: o banco sou_local não existe.`);
  }
  if (code === "42P01") {
    return new LocalPostgresError(`${action}: as tabelas esperadas não existem; execute as migrações primeiro.`);
  }
  return new LocalPostgresError(`${action} falhou (${code}); nenhum dado foi removido.`);
}

async function withPgClient(role, password, db, action, callback) {
  const client = createPgClient(role, password, db);
  try {
    await client.connect();
    return await callback(client);
  } catch (error) {
    throw sanitizedDatabaseFailure(error, action);
  } finally {
    await client.end().catch(() => {});
  }
}

async function inspectCluster(state) {
  return withPgClient(
    adminRole,
    state.adminPassword,
    "postgres",
    "Não foi possível verificar o cluster local",
    async (client) => {
      const result = await client.query(`
        SELECT
          current_setting('data_directory') AS data_directory,
          current_setting('port')::integer AS port,
          current_setting('listen_addresses') AS listen_addresses
      `);
      const row = result.rows[0];
      if (
        !row ||
        !equivalentPath(row.data_directory, dataDirectory) ||
        Number(row.port) !== port ||
        row.listen_addresses !== host
      ) {
        throw new LocalPostgresError(
          "A instância que responde em 127.0.0.1:5432 não corresponde ao cluster configurado. Nenhum processo foi interrompido."
        );
      }
      return row;
    }
  );
}

async function checkPortAvailable() {
  await new Promise((resolveProbe, rejectProbe) => {
    const probe = createServer();
    probe.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        rejectProbe(
          new LocalPostgresError(
            `A porta ${host}:${port} já está ocupada por outro processo. O script não encerrará processos externos.`
          )
        );
      } else {
        rejectProbe(new LocalPostgresError(`Não foi possível verificar a porta ${host}:${port} (${error.code ?? "erro"}).`));
      }
    });
    probe.listen(port, host, () => {
      probe.close((error) => {
        if (error) rejectProbe(error);
        else resolveProbe();
      });
    });
  });
}

async function pgCtlStatus() {
  const result = await runExecutable(pgCtlPath, ["status", "-D", dataDirectory], 15_000);
  return { running: result.code === 0, result };
}

async function initializeCluster(state) {
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  if (await isDirectoryInitialized()) return;
  if (await directoryHasEntries(dataDirectory)) {
    throw new LocalPostgresError(
      `O diretório ${dataDirectory} não está vazio e não contém PG_VERSION. Ele foi preservado.`
    );
  }

  const passwordFile = resolve(runtimeRoot, `.initdb-password-${randomBytes(12).toString("hex")}.tmp`);
  try {
    await writeNewFile(passwordFile, `${state.adminPassword}\n`);
    await runChecked(
      initdbPath,
      [
        "--pgdata",
        dataDirectory,
        "--username",
        adminRole,
        "--encoding=UTF8",
        "--auth=scram-sha-256",
        "--pwfile",
        passwordFile
      ],
      180_000
    );
  } finally {
    await rm(passwordFile, { force: true }).catch(() => {});
  }
}

async function startCluster(state) {
  await requireBinary(pgCtlPath);
  if (!(await isDirectoryInitialized())) {
    throw new LocalPostgresError("Cluster local ainda não inicializado. Execute setup primeiro.");
  }

  const status = await pgCtlStatus();
  if (status.running) {
    await inspectCluster(state);
    console.log("PostgreSQL local já estava ativo em 127.0.0.1:5432.");
    return;
  }

  await checkPortAvailable();
  await runChecked(
    pgCtlPath,
    [
      "start",
      "-D",
      dataDirectory,
      "-l",
      resolve(runtimeRoot, "postgres.log"),
      "-w",
      "-t",
      "45",
      "-o",
      `-h ${host} -p ${port}`
    ],
    60_000
  );
  await inspectCluster(state);
  console.log("PostgreSQL local iniciado em 127.0.0.1:5432.");
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureRoleAndDatabase(state) {
  await withPgClient(adminRole, state.adminPassword, "postgres", "Não foi possível configurar o banco local", async (client) => {
    const databaseResult = await client.query(
      "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
      [database]
    );
    if (databaseResult.rowCount > 0 && databaseResult.rows[0].owner !== appRole) {
      throw new LocalPostgresError(
        `O banco ${database} já existe com owner incompatível (${databaseResult.rows[0].owner}). O script preservou banco e dados existentes.`
      );
    }

    const roleResult = await client.query(
      "SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1",
      [appRole]
    );
    if (roleResult.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${quoteIdentifier(appRole)} LOGIN NOSUPERUSER PASSWORD ${quoteLiteral(state.appPassword)}`
      );
    } else {
      const role = roleResult.rows[0];
      if (role.rolsuper || !role.rolcanlogin) {
        throw new LocalPostgresError(
          `A role ${appRole} já existe com privilégios incompatíveis. O script preservou a role e não alterou seus dados.`
        );
      }
    }

    if (databaseResult.rowCount === 0) {
      await client.query(
        `CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(appRole)}`
      );
    }
  });

  await withPgClient(appRole, state.appPassword, database, "Não foi possível validar a role da aplicação", async (client) => {
    const result = await client.query("SELECT 1 AS ready");
    if (result.rows[0]?.ready !== 1) {
      throw new LocalPostgresError("A role da aplicação não passou pela verificação de conexão.");
    }
  });
}

function generatedEnvironment(state) {
  return [
    "# Gerado por scripts/postgres-local.mjs; contém credenciais locais.",
    "NODE_ENV=development",
    `API_HOST=${host}`,
    "API_PORT=3000",
    `DATABASE_URL=${connectionUrl(appRole, state.appPassword, database)}`,
    "META_VERIFY_TOKEN=dev-verify-token",
    "META_APP_SECRET=dev-app-secret",
    "META_REQUIRE_SIGNATURE=true",
    ""
  ].join("\n");
}

async function ensureEnvironmentFile(state, environment) {
  if (environment.exists) {
    assertConfigMatchesState(environment, state);
    return false;
  }
  try {
    await writeNewFile(appEnvironmentPath, generatedEnvironment(state));
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const racedEnvironment = await readEnvironmentFile();
    assertConfigMatchesState(racedEnvironment, state);
    return false;
  }
}

async function setup() {
  await preflightBinaries();
  const environment = await readEnvironmentFile();
  let state = await readState();
  const initialized = await isDirectoryInitialized();
  if (!state && initialized) {
    throw new LocalPostgresError(
      `O cluster em ${dataDirectory} já contém dados, mas ${statePath} está ausente. O script não tentará recuperar ou substituir credenciais.`
    );
  }
  if (!state && (await directoryHasEntries(dataDirectory))) {
    throw new LocalPostgresError(
      `O diretório ${dataDirectory} contém arquivos sem um cluster reconhecível. Ele foi preservado.`
    );
  }

  const running = state ? await pgCtlStatus() : { running: false };
  if (running.running) {
    await inspectCluster(state);
  } else {
    await checkPortAvailable();
  }

  state ??= await loadOrCreateState({ environment, allowCreate: true });
  assertConfigMatchesState(environment, state);
  await initializeCluster(state);
  if (!running.running) await startCluster(state);
  await ensureRoleAndDatabase(state);
  const createdEnvironment = await ensureEnvironmentFile(state, environment);
  console.log(
    createdEnvironment
      ? `Configuração local criada em ${appEnvironmentPath}.`
      : `Configuração local existente preservada em ${appEnvironmentPath}.`
  );
  console.log("Banco sou_local pronto; dados e credenciais existentes foram preservados.");
}

async function start() {
  await requireBinary(pgCtlPath);
  const environment = await readEnvironmentFile();
  const state = await loadOrCreateState({ environment, allowCreate: false });
  await startCluster(state);
}

async function stop() {
  await requireBinary(pgCtlPath);
  const state = await readState();
  if (!state || !(await isDirectoryInitialized())) {
    console.log("PostgreSQL local não inicializado; nada a parar.");
    return;
  }

  const status = await pgCtlStatus();
  if (!status.running) {
    console.log("PostgreSQL local já estava parado.");
    return;
  }
  await inspectCluster(state);
  await runChecked(
    pgCtlPath,
    ["stop", "-D", dataDirectory, "-m", "fast", "-w", "-t", "45"],
    60_000
  );
  console.log("PostgreSQL local parado.");
}

async function status() {
  await requireBinary(pgCtlPath);
  if (!(await isDirectoryInitialized())) {
    console.log("PostgreSQL local não inicializado.");
    return;
  }

  const result = await pgCtlStatus();
  if (!result.running) {
    console.log("PostgreSQL local parado.");
    return;
  }

  const state = await readState();
  if (state) await inspectCluster(state);
  console.log("PostgreSQL local ativo em 127.0.0.1:5432.");
}

async function seed() {
  const environment = await readEnvironmentFile();
  const state = await loadOrCreateState({ environment, allowCreate: false });
  await inspectCluster(state);
  await withPgClient(appRole, state.appPassword, database, "Seed local falhou", async (client) => {
    await client.query("BEGIN");
    try {
      const tenantTable = await client.query("SELECT to_regclass('public.tenants') AS table_name");
      const channelTable = await client.query("SELECT to_regclass('public.channels') AS table_name");
      if (!tenantTable.rows[0]?.table_name || !channelTable.rows[0]?.table_name) {
        throw new LocalPostgresError("Execute as migrações antes do seed local.");
      }

      await client.query(
        `INSERT INTO tenants (slug, display_name)
         VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING`,
        [seedTenantSlug, "Demonstração local"]
      );
      const tenantResult = await client.query(
        "SELECT id, status FROM tenants WHERE slug = $1",
        [seedTenantSlug]
      );
      const tenantId = tenantResult.rows[0]?.id;
      if (!tenantId) throw new LocalPostgresError("Não foi possível obter o tenant local-demo.");
      if (tenantResult.rows[0].status !== "ACTIVE") {
        throw new LocalPostgresError("O tenant local-demo não está ativo. Seu estado foi preservado.");
      }

      await client.query(
        `INSERT INTO channels (tenant_id, provider, provider_phone_number_id, display_phone_number)
         VALUES ($1, 'META_WHATSAPP', $2, 'Local')
         ON CONFLICT (provider, provider_phone_number_id) DO NOTHING`,
        [tenantId, seedPhoneNumberId]
      );
      const channelResult = await client.query(
        `SELECT tenant_id, status
         FROM channels
         WHERE provider = 'META_WHATSAPP' AND provider_phone_number_id = $1`,
        [seedPhoneNumberId]
      );
      const channel = channelResult.rows[0];
      if (!channel || channel.tenant_id !== tenantId) {
        throw new LocalPostgresError(
          `O identificador ${seedPhoneNumberId} já está associado a outro tenant. Nenhum registro existente foi alterado.`
        );
      }
      if (channel.status !== "ACTIVE") {
        throw new LocalPostgresError(
          `O canal ${seedPhoneNumberId} já existe inativo. O script preservou seu estado.`
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
  console.log(`Seed local pronto: tenant ${seedTenantSlug} e canal ${seedPhoneNumberId}.`);
}

async function main() {
  const command = process.argv[2];
  if (command === "--help" || command === "-h" || command === "help") {
    usage();
    return;
  }
  if (!["setup", "start", "stop", "status", "seed"].includes(command)) {
    usage();
    process.exitCode = 2;
    return;
  }

  switch (command) {
    case "setup":
      await setup();
      break;
    case "start":
      await start();
      break;
    case "stop":
      await stop();
      break;
    case "status":
      await status();
      break;
    case "seed":
      await seed();
      break;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Erro inesperado.";
  console.error(`PostgreSQL local: ${message}`);
  process.exitCode = 1;
});
