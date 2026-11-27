import type { GuardrailViolation, InputGuardResult, ObjectiveGuardResult } from "./types.js";

const BIDI_AND_INVISIBLE_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]/g;
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

interface DetectionRule {
  code: string;
  category: GuardrailViolation["category"];
  severity: GuardrailViolation["severity"];
  weight: number;
  pattern: RegExp;
  message: string;
}

const INPUT_INJECTION_RULES: readonly DetectionRule[] = [
  {
    code: "prompt_injection_override",
    category: "prompt_injection",
    severity: "critical",
    weight: 90,
    pattern: /\b(?:ignore|desconsidere|esqueca|esqueça|anule|substitua|disregard|override|forget)\b.{0,40}\b(?:instrucoes|instruções|regras|prompt|diretrizes|sistema|comandos|instructions|rules|guidelines|system|previous|anteriores|acima)\b/i,
    message: "Tentativa de sobrescrever instruções do sistema."
  },
  {
    code: "prompt_injection_jailbreak_persona",
    category: "prompt_injection",
    severity: "critical",
    weight: 85,
    pattern: /\b(?:modo\s+desenvolvedor|developer\s+mode|jailbreak|dan\s+mode|sem\s+restricoes|sem\s+restrições|sem\s+limites|bypass\s+(?:safety|guardrails|rules)|finja\s+(?:que\s+)?(?:voce|você)\s+(?:e|é|nao|não)|agora\s+(?:voce|você)\s+(?:e|é)\s+um|pretend\s+you\s+are|you\s+are\s+now\s+(?:a|an|in))\b/i,
    message: "Tentativa de jailbreak ou troca forçada de papel."
  },
  {
    code: "prompt_injection_role_delimiter",
    category: "prompt_injection",
    severity: "high",
    weight: 80,
    pattern: /(?:^|\n)\s*(?:<\|(?:im_start|system|assistant|developer)\|>|\[(?:SYSTEM|INST|ADMIN|DEVELOPER)\]|###\s*(?:SYSTEM|INSTRUCTIONS?|REGRAS\s+DO\s+SISTEMA)|<<<\s*SYSTEM\s*>>>|(?:system|developer)\s*:\s*(?:ignore|you\s+are|voce\s+e|você\s+é|responda|execute))/i,
    message: "Marcadores falsos de papel/sistema na mensagem do cliente."
  },
  {
    code: "prompt_exfiltration_system_prompt",
    category: "exfiltration",
    severity: "critical",
    weight: 90,
    pattern: /\b(?:mostre|revele|exiba|imprima|repita|copie|vaze|show|reveal|print|dump|repeat|leak)\b.{0,45}\b(?:system\s*prompt|prompt\s*(?:do\s+sistema|interno|inicial|completo)|instrucoes\s+internas|instruções\s+internas|regras\s+internas|regras\s+ocultas|hidden\s+instructions)\b/i,
    message: "Tentativa de exfiltração do prompt ou regras internas."
  },
  {
    code: "exfiltration_secrets_or_cross_tenant",
    category: "exfiltration",
    severity: "critical",
    weight: 95,
    pattern: /\b(?:process\.env|webhook_secret|api[_\s-]?key|chave\s+de\s+api|token\s+de\s+acesso|senha\s+do\s+banco|database_url|listar\s+todos\s+os\s+clientes|dados\s+de\s+outros\s+clientes|outras\s+empresas|outros\s+tenants|dump\s+(?:da\s+base|do\s+banco|database))\b/i,
    message: "Tentativa de extração de segredos ou dados de outros clientes/empresas."
  },
  {
    code: "pricing_manipulation_injection",
    category: "pricing",
    severity: "high",
    weight: 80,
    pattern: /\b(?:altere|mude|troque|defina|force|set|change)\s+(?:o\s+)?(?:preco|preço|valor|total)\s+(?:para|pra|to)\b|\b(?:aplique|conceda|me\s+de|me\s+dê|da|dá)\s+(?:um\s+)?(?:desconto\s+de\s+\d{1,3}\s*%|100%\s+de\s+desconto|gratis|grátis|de\s+graca|de\s+graça)\b|\bcobre\s+r\$\s*0\b/i,
    message: "Tentativa de manipulação direta de preço ou desconto."
  }
];

const OBJECTIVE_FORBIDDEN_RULES: readonly DetectionRule[] = [
  {
    code: "objective_override_rules",
    category: "objective",
    severity: "critical",
    weight: 100,
    pattern: /\b(?:ignore|desconsidere|anule|desative|bypass|override)\b.{0,40}\b(?:regras|guardrails|seguranca|segurança|travas|politicas|políticas|precos|preços|cardapio|cardápio|confirmacao|confirmação|system\s*prompt)\b/i,
    message: "O objetivo do bot não pode desativar regras de segurança ou travas operacionais."
  },
  {
    code: "objective_secret_disclosure",
    category: "objective",
    severity: "critical",
    weight: 100,
    pattern: /\b(?:revele|compartilhe|exponha|envie|mostre)\b.{0,40}\b(?:api[_\s-]?key|chave\s+de\s+api|segredo|webhook_secret|system\s*prompt|dados\s+de\s+outros\s+(?:clientes|tenants|empresas))\b/i,
    message: "O objetivo do bot não pode instruir exposição de segredos ou dados de terceiros."
  },
  {
    code: "objective_bypass_confirmation_or_pricing",
    category: "objective",
    severity: "high",
    weight: 90,
    pattern: /\b(?:invente\s+(?:precos|preços|valores|disponibilidade)|confirme\s+(?:pedidos?\s+)?sem\s+(?:confirmacao|confirmação|aprovacao|aprovação)\s+do\s+cliente|aceite\s+(?:qualquer\s+)?(?:preco|preço|desconto)\s+(?:informado|pedido)\s+pelo\s+cliente)\b/i,
    message: "O objetivo do bot não pode autorizar invenção de preços ou confirmação sem aprovação do cliente."
  },
  {
    code: "objective_role_delimiter",
    category: "objective",
    severity: "high",
    weight: 85,
    pattern: /(?:<\|(?:im_start|system|assistant|developer)\|>|\[(?:SYSTEM|INST|DEVELOPER)\]|<<<\s*SYSTEM\s*>>>)/i,
    message: "O objetivo do bot contém delimitadores reservados de sistema."
  }
];

export const MAX_ASSISTANT_OBJECTIVE_LENGTH = 1_000;
export const MAX_CUSTOMER_INPUT_LENGTH = 4_000;

export function stripInvisibleAndControlChars(text: string): { cleaned: string; hadBidiOrInvisible: boolean } {
  const hadBidiOrInvisible = BIDI_AND_INVISIBLE_PATTERN.test(text);
  BIDI_AND_INVISIBLE_PATTERN.lastIndex = 0;
  const cleaned = text
    .replace(BIDI_AND_INVISIBLE_PATTERN, "")
    .replace(CONTROL_CHARS_PATTERN, "")
    .trim();
  return { cleaned, hadBidiOrInvisible };
}

export function inspectCustomerInput(text: string): InputGuardResult {
  const violations: GuardrailViolation[] = [];
  let riskScore = 0;

  const { cleaned, hadBidiOrInvisible } = stripInvisibleAndControlChars(text);
  if (hadBidiOrInvisible) {
    violations.push({
      code: "unicode_bidi_or_invisible",
      category: "unicode",
      severity: "medium",
      message: "Caracteres invisíveis ou bidirecionais removidos da entrada."
    });
    riskScore += 30;
  }

  const normalizedForScan = cleaned
    .normalize("NFKC")
    .replace(/\s+/g, " ");

  for (const rule of INPUT_INJECTION_RULES) {
    if (rule.pattern.test(normalizedForScan)) {
      violations.push({
        code: rule.code,
        category: rule.category,
        severity: rule.severity,
        message: rule.message
      });
      riskScore += rule.weight;
    }
  }

  if (cleaned.length > MAX_CUSTOMER_INPUT_LENGTH) {
    violations.push({
      code: "input_too_long",
      category: "prompt_injection",
      severity: "high",
      message: `Mensagem excede o limite de ${MAX_CUSTOMER_INPUT_LENGTH} caracteres.`
    });
    riskScore += 70;
  }

  const hasCriticalOrHigh = violations.some((v) => v.severity === "critical" || v.severity === "high");
  if (hasCriticalOrHigh || riskScore >= 75) {
    return {
      allowed: false,
      sanitizedText: cleaned.slice(0, MAX_CUSTOMER_INPUT_LENGTH),
      action: "handoff",
      violations,
      riskScore: Math.min(100, riskScore)
    };
  }

  if (hadBidiOrInvisible) {
    return {
      allowed: true,
      sanitizedText: cleaned,
      action: "sanitize",
      violations,
      riskScore
    };
  }

  return {
    allowed: true,
    sanitizedText: cleaned,
    action: "allow",
    violations: [],
    riskScore: 0
  };
}

export function validateAssistantObjective(rawObjective: string): ObjectiveGuardResult {
  const trimmed = rawObjective.trim();
  if (trimmed.length > MAX_ASSISTANT_OBJECTIVE_LENGTH) {
    const violation: GuardrailViolation = {
      code: "objective_too_long",
      category: "objective",
      severity: "high",
      message: `O objetivo do bot deve ter no máximo ${MAX_ASSISTANT_OBJECTIVE_LENGTH} caracteres.`
    };
    return {
      ok: false,
      sanitizedObjective: trimmed.slice(0, MAX_ASSISTANT_OBJECTIVE_LENGTH),
      violations: [violation],
      reason: violation.message
    };
  }

  const { cleaned, hadBidiOrInvisible } = stripInvisibleAndControlChars(trimmed);
  const violations: GuardrailViolation[] = [];
  if (hadBidiOrInvisible) {
    violations.push({
      code: "objective_unicode_bidi",
      category: "unicode",
      severity: "high",
      message: "O objetivo do bot não pode conter caracteres Unicode invisíveis ou bidirecionais."
    });
  }

  const normalized = cleaned.normalize("NFKC").replace(/\s+/g, " ");
  for (const rule of OBJECTIVE_FORBIDDEN_RULES) {
    if (rule.pattern.test(normalized)) {
      violations.push({
        code: rule.code,
        category: rule.category,
        severity: rule.severity,
        message: rule.message
      });
    }
  }

  if (violations.length > 0) {
    return {
      ok: false,
      sanitizedObjective: cleaned,
      violations,
      reason: violations[0]!.message
    };
  }

  return {
    ok: true,
    sanitizedObjective: cleaned,
    violations: []
  };
}
