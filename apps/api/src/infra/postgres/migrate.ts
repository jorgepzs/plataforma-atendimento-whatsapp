import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../../config.js";

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error("DATABASE_URL é obrigatória para executar migrações.");
}

const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock(20261003)");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationsDirectory = path.resolve(process.cwd(), "migrations");
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of filenames) {
    const alreadyApplied = await client.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename]
    );

    if (alreadyApplied.rowCount) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDirectory, filename), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      console.info(`Migração aplicada: ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(20261003)");
  client.release();
  await pool.end();
}

