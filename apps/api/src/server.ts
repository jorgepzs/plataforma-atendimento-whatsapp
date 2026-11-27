import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MemoryInboundEventStore } from "./infra/memory/memory-inbound-event-store.js";
import { PostgresDatabase } from "./infra/postgres/postgres-database.js";
import { PostgresInboundEventStore } from "./infra/postgres/postgres-inbound-event-store.js";
import { SqliteLocalDatabase } from "./infra/sqlite/local-database.js";
import { SqliteInboundEventStore } from "./infra/sqlite/sqlite-inbound-event-store.js";

const config = loadConfig();
const postgresDatabase = config.databaseUrl
  ? await PostgresDatabase.open(config.databaseUrl)
  : undefined;
const localDatabase = !postgresDatabase && config.localSqlitePath
  ? new SqliteLocalDatabase(config.localSqlitePath)
  : undefined;
const store = postgresDatabase
  ? new PostgresInboundEventStore(postgresDatabase)
  : localDatabase
    ? new SqliteInboundEventStore(localDatabase)
    : new MemoryInboundEventStore();

const app = await buildApp({
  config,
  store,
  ...(postgresDatabase ? { postgresDatabase } : {}),
  ...(localDatabase ? { localDatabase } : {})
});
let shuttingDown = false;

if (store.kind === "memory") {
  app.log.warn(
    "DATABASE_URL não configurada. A API está usando armazenamento volátil apenas para desenvolvimento."
  );
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Encerrando API.");
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("message", (message) => {
  if (typeof message === "object" && message !== null && "type" in message && message.type === "shutdown") {
    void shutdown("IPC");
  }
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ error }, "Não foi possível iniciar a API.");
  await app.close();
  process.exit(1);
}
