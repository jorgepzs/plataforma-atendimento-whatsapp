const documentedPrefixes = ["LLM_", "WHATSAPP_", "LOCAL_AI_", "META_"];
const documentedKeys = new Set(["LOCAL_SQLITE_PATH", "LOG_LEVEL", "ENABLE_LOCAL_DEMO"]);

export function selectDocumentedEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    documentedKeys.has(key) || documentedPrefixes.some((prefix) => key.startsWith(prefix))
  ));
}
