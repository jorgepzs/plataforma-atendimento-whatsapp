import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MemoryInboundEventStore } from "./infra/memory/memory-inbound-event-store.js";
import { PostgresInboundEventStore } from "./infra/postgres/postgres-inbound-event-store.js";
import { SqliteLocalDatabase } from "./infra/sqlite/local-database.js";
import { SqliteInboundEventStore } from "./infra/sqlite/sqlite-inbound-event-store.js";

const config = loadConfig();
const localDatabase = config.localSqlitePath ? new SqliteLocalDatabase(config.localSqlitePath) : undefined;
const store = config.databaseUrl
  ? new PostgresInboundEventStore(
      new Pool({
        connectionString: config.databaseUrl,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000
      })
    )
  : localDatabase ? new SqliteInboundEventStore(localDatabase) : new MemoryInboundEventStore();

const app = await buildApp({ config, store, ...(localDatabase ? { localDatabase } : {}) });
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

