import { allowedAmounts, mentionsUnknownPrice } from "../ordering/money.js";
import { stripInvisibleAndControlChars } from "./input-guard.js";
import type { GuardrailViolation, OutputGuardContext, OutputGuardResult } from "./types.js";

const DEFAULT_MAX_REPLY_LENGTH = 1_500;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|xi|whsec|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9._-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:[A-Z0-9_]*API_KEY|[A-Z0-9_]*WEBHOOK_SECRET|META_APP_SECRET|DATABASE_URL)\s*[:=]\s*\S+/gi
];

const INTERNAL_URL_PATTERN = /\b(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|169\.254\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?(?:\/[^\s]*)?|postgres(?:ql)?:\/\/[^\s]+|file:\/\/[^\s]+)\b/gi;

const PROMPT_LEAK_PATTERN = /\b(?:<system_rules>|=== DADOS NÃO CONFIÁVEIS ===|=== INSTRUÇÕES IMUTÁVEIS ===|SYSTEM PROMPT INTERNO|hierarchical instruction policy)\b/i;

const INVENTED_DISCOUNT_PATTERN = /\b(?:apliquei|concedi|garanti|liberei|ativei)\s+(?:um\s+)?(?:desconto|cupom|brinde|cortesia)\b|\b(?:desconto\s+(?:especial|exclusivo)\s+de\s+\d{1,3}\s*%|100%\s+de\s+desconto|sai\s+de\s+gra[çc]a|por\s+conta\s+da\s+casa)\b/i;
const DISCOUNT_TERMS = "(?:desconto|cupom|cortesia|brinde|promoção|promocao)";
const DISCOUNT_DENIAL_PATTERN = new RegExp(
  `\\b(?:não|nao|nunca|sem|proibido|proibida|vedado|vedada)\\b.{0,60}\\b${DISCOUNT_TERMS}\\b|\\b${DISCOUNT_TERMS}\\b.{0,40}\\b(?:não|nao|proibido|proibida|vedado|vedada)\\b`,
  "i"
);
const DISCOUNT_PERMISSION_PATTERN = new RegExp(
  `\\b(?:oferecemos?|concedemos?|aplicamos?|autorizamos?|permitimos?|aceitamos?|possuem?|garantimos?|tem direito a)\\b.{0,60}\\b${DISCOUNT_TERMS}\\b|\\b${DISCOUNT_TERMS}\\b.{0,60}\\b(?:oferecido|oferecida|autorizado|autorizada|permitido|permitida|disponível|disponivel)\\b`,
  "i"
);

const FALSE_CONFIRMATION_ASSERTION_PATTERN = /\b(?:seu\s+pedido\s+(?:ja|já)?\s*(?:foi|esta|está)\s+(?:confirmado|finalizado|enviado\s+para\s+(?:a\s+cozinha|preparo|producao|produção))|pedido\s+(?:confirmado|finalizado)\s+com\s+sucesso|ja\s+confirmei\s+(?:o\s+)?seu\s+pedido|já\s+confirmei\s+(?:o\s+)?seu\s+pedido|confirmacao\s+concluida|confirmação\s+concluída)\b/i;

const CONFIRMATION_QUESTION_GUARD = /\b(?:responda\s+["“]?sim["”]?|deseja\s+confirmar|posso\s+confirmar|aguardando\s+(?:sua\s+)?confirma[çc][ãa]o|confirma\s+o\s+pedido\?)\b/i;

const CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

export function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function redactCreditCards(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const output = text.replace(CARD_CANDIDATE_PATTERN, (match) => {
    const digits = match.replace(/[^\d]/g, "");
    if (passesLuhn(digits)) {
      redacted = true;
      return "[CARTÃO REMOVIDO]";
    }
    return match;
  });
  return { text: output, redacted };
}

export function guardAssistantOutput(rawText: string, context: OutputGuardContext): OutputGuardResult {
  const violations: GuardrailViolation[] = [];
  const maxLength = context.maxLength ?? DEFAULT_MAX_REPLY_LENGTH;

  let text = stripInvisibleAndControlChars(rawText).cleaned;
  if (!text) {
    return {
      ok: false,
      sanitizedText: "",
      blocked: true,
      violations: [
        {
          code: "empty_output",
          category: "pii_secret",
          severity: "medium",
          message: "Resposta vazia após sanitização."
        }
      ]
    };
  }

  for (const secret of context.secrets ?? []) {
    if (secret && secret.length >= 6 && text.includes(secret)) {
      text = text.split(secret).join("[REDACTED]");
      violations.push({
        code: "secret_value_leaked",
        category: "pii_secret",
        severity: "critical",
        message: "Segredo configurado detectado e redigido da resposta."
      });
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      pattern.lastIndex = 0;
      text = text.replace(pattern, "[REDACTED]");
      violations.push({
        code: "secret_pattern_leaked",
        category: "pii_secret",
        severity: "critical",
        message: "Credencial ou token detectado e redigido da resposta."
      });
    }
    pattern.lastIndex = 0;
  }

  if (INTERNAL_URL_PATTERN.test(text)) {
    INTERNAL_URL_PATTERN.lastIndex = 0;
    text = text.replace(INTERNAL_URL_PATTERN, "[ENDEREÇO INTERNO REMOVIDO]");
    violations.push({
      code: "internal_url_leaked",
      category: "exfiltration",
      severity: "high",
      message: "URL interna detectada e removida da resposta."
    });
  }
  INTERNAL_URL_PATTERN.lastIndex = 0;

  const cardScan = redactCreditCards(text);
  if (cardScan.redacted) {
    text = cardScan.text;
    violations.push({
      code: "credit_card_pii_redacted",
      category: "pii_secret",
      severity: "high",
      message: "Número de cartão de crédito detectado e removido da resposta."
    });
  }

  if (PROMPT_LEAK_PATTERN.test(text)) {
    violations.push({
      code: "system_prompt_leak",
      category: "exfiltration",
      severity: "critical",
      message: "Tentativa de vazamento de instruções internas bloqueada."
    });
    return { ok: false, sanitizedText: "", blocked: true, violations };
  }

  const allowed = allowedAmounts(context.catalog, context.profile, context.order);
  if (mentionsUnknownPrice(text, allowed)) {
    violations.push({
      code: "unknown_price_mentioned",
      category: "pricing",
      severity: "high",
      message: "Resposta mencionou preço fora do catálogo/pedido oficial."
    });
    return { ok: false, sanitizedText: "", blocked: true, violations };
  }

  const normalizedPolicies = (context.profile.policies ?? "").toLocaleLowerCase("pt-BR");
  const discountExplicitlyAllowed =
    DISCOUNT_PERMISSION_PATTERN.test(normalizedPolicies) && !DISCOUNT_DENIAL_PATTERN.test(normalizedPolicies);
  if (INVENTED_DISCOUNT_PATTERN.test(text) && !discountExplicitlyAllowed) {
    violations.push({
      code: "invented_discount",
      category: "pricing",
      severity: "high",
      message: "Resposta ofereceu desconto ou cortesia sem respaldo nas políticas."
    });
    return { ok: false, sanitizedText: "", blocked: true, violations };
  }

  const serverConfirmed =
    context.confirmedInThisTurn === true ||
    context.order?.status === "confirmed" ||
    context.order?.status === "sent_to_integration";

  if (!serverConfirmed && FALSE_CONFIRMATION_ASSERTION_PATTERN.test(text) && !CONFIRMATION_QUESTION_GUARD.test(text)) {
    violations.push({
      code: "false_order_confirmation",
      category: "false_confirmation",
      severity: "critical",
      message: "Resposta afirmou confirmação de pedido sem confirmação efetivada no servidor."
    });
    return { ok: false, sanitizedText: "", blocked: true, violations };
  }

  const hasCriticalLeak = violations.some((v) => v.code === "secret_value_leaked" || v.code === "secret_pattern_leaked");
  if (hasCriticalLeak) {
    return { ok: false, sanitizedText: "", blocked: true, violations };
  }

  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  const bounded = cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;

  return {
    ok: true,
    sanitizedText: bounded,
    blocked: false,
    violations
  };
}
