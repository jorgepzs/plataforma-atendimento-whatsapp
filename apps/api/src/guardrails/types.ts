import type { BusinessProfile, CatalogItem, CustomerOrder } from "../ordering/types.js";

export type GuardrailSeverity = "low" | "medium" | "high" | "critical";

export type GuardrailCategory =
  | "prompt_injection"
  | "exfiltration"
  | "pii_secret"
  | "pricing"
  | "false_confirmation"
  | "objective"
  | "tool_policy"
  | "unicode";

export interface GuardrailViolation {
  code: string;
  severity: GuardrailSeverity;
  category: GuardrailCategory;
  message: string;
}

export interface InputGuardResult {
  allowed: boolean;
  sanitizedText: string;
  action: "allow" | "sanitize" | "handoff" | "block";
  violations: GuardrailViolation[];
  riskScore: number;
}

export interface ObjectiveGuardResult {
  ok: boolean;
  sanitizedObjective: string;
  violations: GuardrailViolation[];
  reason?: string;
}

export interface OutputGuardContext {
  catalog: readonly CatalogItem[];
  profile: BusinessProfile;
  order: CustomerOrder | null;
  confirmedInThisTurn?: boolean;
  secrets?: readonly (string | null | undefined)[];
  maxLength?: number;
}

export interface OutputGuardResult {
  ok: boolean;
  sanitizedText: string;
  blocked: boolean;
  violations: GuardrailViolation[];
}

export interface ToolGuardInput {
  toolName: string;
  args: unknown;
  allowedTools: readonly string[];
  callCountInTurn: number;
  maxCallsPerTurn?: number;
  maxArgChars?: number;
}

export interface ToolGuardResult {
  ok: boolean;
  error?: string;
  message?: string;
  sanitizedArgs?: Record<string, unknown>;
  violations: GuardrailViolation[];
}
