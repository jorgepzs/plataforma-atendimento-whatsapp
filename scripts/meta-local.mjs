import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOKEN_BYTES = 8192;
const FIELDS = Object.freeze([
  "META_PHONE_NUMBER_ID",
  "META_WABA_ID",
  "META_GRAPH_API_VERSION",
  "META_ACCESS_TOKEN",
  "META_OUTBOUND_ENABLED",
]);
const FIELD_SET = new Set(FIELDS);
const PLACEHOLDER_PREFIXES = Object.freeze([
  "your",
  "replace",
  "change",
  "insert",
  "paste",
  "put",
  "placeholder",
  "example",
  "dummy",
  "fake",
  "todo",
  "redacted",
  "seu",
  "cole",
  "troque",
  "substitua",
  "insira",
]);
const PLACEHOLDER_VALUES = new Set([
  "metaaccesstoken",
  "accesstokenhere",
  "tokenhere",
  "notarealtoken",
]);
const DEFAULT_FILE = fileURLToPath(new URL("../.env.meta.local", import.meta.url));

function addIssue(issues, field, code) {
  if (!issues.some((issue) => issue.field === field && issue.code === code)) {
    issues.push({ field, code });
  }
}

function parseValue(rawValue) {
  const candidate = rawValue.replace(/^[\t ]+/, "");
  const first = candidate[0];

  if (first === "\"" || first === "'" || first === "`") {
    const closingIndex = candidate.indexOf(first, 1);
    if (closingIndex < 0) {
      return { valid: false };
    }

    const remainder = candidate.slice(closingIndex + 1).replace(/^[\t ]+/, "");
    if (remainder !== "" && !remainder.startsWith("#")) {
      return { valid: false };
    }

    return { valid: true, value: candidate.slice(1, closingIndex) };
  }

  const commentIndex = candidate.search(/[\t ]+#/);
  const value = (commentIndex < 0 ? candidate : candidate.slice(0, commentIndex))
    .replace(/[\t ]+$/, "");
  return { valid: true, value };
}

function parseLines(source) {
  const values = Object.create(null);
  const issues = [];
  const seen = new Set();

  for (const originalLine of source.split("\n")) {
    const line = originalLine.endsWith("\r")
      ? originalLine.slice(0, -1)
      : originalLine;
    const trimmed = line.replace(/^[\t ]+/, "");
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const match = line.match(/^[\t ]*([A-Za-z_][A-Za-z0-9_]*)[\t ]*=(.*)$/);
    if (!match) {
      addIssue(issues, "FILE", "INVALID_FORMAT");
      continue;
    }

    const [, key, rawValue] = match;
    if (seen.has(key)) {
      addIssue(issues, FIELD_SET.has(key) ? key : "UNKNOWN_FIELD", "DUPLICATE_FIELD");
      continue;
    }
    seen.add(key);

    if (!FIELD_SET.has(key)) {
      addIssue(issues, "UNKNOWN_FIELD", "UNKNOWN_FIELD");
      continue;
    }

    const parsed = parseValue(rawValue);
    if (!parsed.valid) {
      addIssue(issues, "FILE", "INVALID_FORMAT");
      continue;
    }
    values[key] = parsed.value;
  }

  return { values, issues };
}

function isPlaceholderToken(token) {
  const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  return PLACEHOLDER_VALUES.has(normalized)
    || PLACEHOLDER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isPositiveNumericId(value) {
  return /^[1-9][0-9]{0,31}$/.test(value);
}

function validateValues(values, issues) {
  for (const key of FIELDS) {
    if (!Object.hasOwn(values, key)) {
      addIssue(issues, key, "MISSING_FIELD");
      continue;
    }

    const value = values[key];
    if (value === "") {
      addIssue(issues, key, "EMPTY_VALUE");
      continue;
    }

    if (key === "META_PHONE_NUMBER_ID" || key === "META_WABA_ID") {
      if (!isPositiveNumericId(value)) {
        addIssue(issues, key, "INVALID_VALUE");
      }
      continue;
    }

    if (key === "META_GRAPH_API_VERSION") {
      if (!/^v[1-9][0-9]*\.[0-9]+$/.test(value)) {
        addIssue(issues, key, "INVALID_VALUE");
      }
      continue;
    }

    if (key === "META_ACCESS_TOKEN") {
      if (isPlaceholderToken(value)) {
        addIssue(issues, key, "PLACEHOLDER_VALUE");
      } else if (
        value.length > MAX_TOKEN_BYTES
        || !/^[A-Za-z0-9._~+/-]+={0,}$/.test(value)
      ) {
        addIssue(issues, key, "INVALID_VALUE");
      }
      continue;
    }

    if (key === "META_OUTBOUND_ENABLED" && value !== "false") {
      addIssue(issues, key, "OUTBOUND_MUST_BE_FALSE");
    }
  }
}

/** Validate .env-style text without returning or logging any configured values. */
export function validateMetaLocalText(source) {
  if (typeof source !== "string") {
    return { ok: false, issues: [{ field: "FILE", code: "INVALID_FORMAT" }] };
  }

  if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) {
    return { ok: false, issues: [{ field: "FILE", code: "TOO_LARGE" }] };
  }

  const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const parsed = parseLines(withoutBom);
  const issues = [...parsed.issues];
  validateValues(parsed.values, issues);
  return { ok: issues.length === 0, issues };
}

function formatFailure(issues) {
  const details = issues.map(({ field, code }) => `${field}: ${code}`).join("; ");
  return `Configuração não validada. ${details}`;
}

function parseArguments(args) {
  if (args.length === 0) {
    return { valid: true, file: DEFAULT_FILE };
  }
  if (args.length === 2 && args[0] === "--file" && args[1] !== "") {
    return { valid: true, file: path.resolve(args[1]) };
  }
  return { valid: false };
}

function fileProblem(error) {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    return { field: "FILE", code: "NOT_FOUND" };
  }
  return { field: "FILE", code: "UNREADABLE" };
}

async function runCli(args) {
  const parsedArgs = parseArguments(args);
  if (!parsedArgs.valid) {
    process.stderr.write(`${formatFailure([{ field: "CLI_ARGUMENTS", code: "INVALID_USAGE" }])}\n`);
    process.exitCode = 1;
    return;
  }

  let contents;
  try {
    contents = await readFile(parsedArgs.file);
  } catch (error) {
    process.stderr.write(`${formatFailure([fileProblem(error)])}\n`);
    process.exitCode = 1;
    return;
  }

  if (contents.byteLength > MAX_FILE_BYTES) {
    process.stderr.write(`${formatFailure([{ field: "FILE", code: "TOO_LARGE" }])}\n`);
    process.exitCode = 1;
    return;
  }

  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    process.stderr.write(`${formatFailure([{ field: "FILE", code: "INVALID_FORMAT" }])}\n`);
    process.exitCode = 1;
    return;
  }

  const result = validateMetaLocalText(source);
  if (!result.ok) {
    process.stderr.write(`${formatFailure(result.issues)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    "Configuração sintaticamente completa. Token, permissões, expiração e número ainda não foram validados na Meta; envio permanece desativado.\n",
  );
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  const invokedUrl = pathToFileURL(path.resolve(process.argv[1])).href;
  return process.platform === "win32"
    ? invokedUrl.toLowerCase() === import.meta.url.toLowerCase()
    : invokedUrl === import.meta.url;
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch(() => {
    process.stderr.write("Configuração não validada. FILE: UNREADABLE\n");
    process.exitCode = 1;
  });
}
