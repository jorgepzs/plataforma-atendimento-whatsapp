const documentedPrefixes = ["LLM_", "WHATSAPP_", "LOCAL_AI_", "META_", "RAG_"];
const documentedKeys = new Set(["LOCAL_SQLITE_PATH", "DATABASE_URL", "LOG_LEVEL", "ENABLE_LOCAL_DEMO"]);

export function selectLocalStorageMode(argv) {
  const runSmoke = argv.includes("--smoke");
  const explicitPostgres = argv.includes("--postgres");
  const explicitSqlite = argv.includes("--sqlite");
  const explicitMemory = argv.includes("--memory");
  if ([explicitPostgres, explicitSqlite, explicitMemory].filter(Boolean).length > 1) {
    throw new Error("Escolha um único modo de armazenamento.");
  }
  const useMemory = explicitMemory || (runSmoke && !explicitSqlite && !explicitPostgres);
  const usePostgres = explicitPostgres;
  const useSqlite = !usePostgres && !useMemory;
  return { useMemory, useSqlite, usePostgres };
}

export function assertLocalPostgresUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("dev:postgres exige uma DATABASE_URL PostgreSQL local válida.");
  }
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("dev:postgres só aceita PostgreSQL local (localhost, 127.0.0.1 ou ::1), para evitar acesso acidental a um banco remoto.");
  }
  return value;
}

export function selectDocumentedEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    documentedKeys.has(key) || documentedPrefixes.some((prefix) => key.startsWith(prefix))
  ));
}
