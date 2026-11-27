import { createHash } from "node:crypto";
import type { TenantConfig } from "../attendance/types.js";
import { formatCents } from "../ordering/money.js";
import type { CatalogItem } from "../ordering/types.js";
import type { RagSourceKind } from "./types.js";

export interface BuiltRagChunk {
  id: string;
  tenantId: string;
  sourceKind: RagSourceKind;
  sourceKey: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  contentHash: string;
}

const STOPWORDS_PT = new Set([
  "a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "no", "na", "nos", "nas",
  "um", "uma", "uns", "umas", "para", "pra", "por", "com", "sem", "que", "qual", "quais",
  "como", "onde", "quando", "tem", "ter", "voce", "voces", "seu", "sua", "seus", "suas",
  "meu", "minha", "me", "eu", "quero", "gostaria", "favor", "ola", "oi", "bom", "boa"
]);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeRagText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeRagText(text: string): string[] {
  const normalized = normalizeRagText(text);
  if (!normalized) return [];
  const tokens = normalized.split(" ").filter((token) => token.length >= 2 && !STOPWORDS_PT.has(token));
  return tokens.length > 0 ? tokens : normalized.split(" ").filter(Boolean);
}

export function summarizeCatalogCategories(catalog: readonly CatalogItem[]): string {
  const counts = new Map<string, number>();
  for (const item of catalog) {
    if (!item.available) continue;
    const category = item.category.trim() || "Geral";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  return [...counts.entries()]
    .map(([category, count]) => `${category} (${count} ${count === 1 ? "item" : "itens"})`)
    .join(", ");
}

function makeChunk(
  tenantId: string,
  sourceKind: RagSourceKind,
  sourceKey: string,
  title: string,
  content: string,
  metadata: Record<string, unknown> = {}
): BuiltRagChunk {
  const cleanTitle = title.trim();
  const cleanContent = content.replace(/\r\n/g, "\n").trim();
  return {
    id: `${tenantId}:${sourceKind}:${sourceKey}`,
    tenantId,
    sourceKind,
    sourceKey,
    title: cleanTitle,
    content: cleanContent,
    metadata,
    contentHash: sha256(`${cleanTitle}\n${cleanContent}`)
  };
}

export function buildTenantRagChunks(tenantId: string, config: TenantConfig): BuiltRagChunk[] {
  const chunks: BuiltRagChunk[] = [];

  const profileLines = [
    `Empresa: ${config.businessName} (${config.segment})`,
    config.profile.address ? `Endereço: ${config.profile.address}` : "",
    config.profile.serviceArea ? `Área de atendimento: ${config.profile.serviceArea}` : "",
    config.profile.hours ? `Horário de funcionamento: ${config.profile.hours}` : "",
    `Entrega: ${config.profile.deliveryEnabled ? `sim (taxa ${formatCents(config.profile.deliveryFeeCents)})` : "não"}`,
    `Retirada: ${config.profile.pickupEnabled ? "sim" : "não"}`,
    config.profile.paymentMethods.length > 0 ? `Formas de pagamento: ${config.profile.paymentMethods.join(", ")}` : ""
  ].filter(Boolean);

  if (profileLines.length > 0) {
    chunks.push(
      makeChunk(tenantId, "profile", "business", `Informações de ${config.businessName}`, profileLines.join("\n"))
    );
  }

  if (config.profile.policies.trim()) {
    chunks.push(
      makeChunk(tenantId, "policy", "policies", `Políticas de ${config.businessName}`, config.profile.policies.trim())
    );
  }

  config.knowledge.forEach((entry, index) => {
    const question = entry.question.trim();
    const answer = entry.answer.trim();
    if (!question || !answer) return;
    const key = `${index}-${sha256(question).slice(0, 10)}`;
    chunks.push(
      makeChunk(
        tenantId,
        "faq",
        key,
        question,
        `Pergunta: ${question}\nResposta autorizada: ${answer}`,
        { index }
      )
    );
  });

  if (config.orderingEnabled) {
    for (const item of config.catalog) {
      if (!item.available) continue;
      const optionSummary = item.optionGroups.map((group) => {
        const choices = group.choices
          .map((choice) => `${choice.name} (${choice.priceCents >= 0 ? "+" : "-"}${formatCents(Math.abs(choice.priceCents))})`)
          .join(", ");
        return `${group.name}${group.required ? " [obrigatório]" : ""}: ${choices}`;
      }).join(" | ");
      const content = [
        `${item.name} (${item.id}) — Categoria: ${item.category || "Geral"} — Preço base: ${formatCents(item.priceCents)}`,
        item.description ? `Descrição: ${item.description}` : "",
        optionSummary ? `Opções: ${optionSummary}` : ""
      ].filter(Boolean).join("\n");
      chunks.push(
        makeChunk(tenantId, "catalog_item", item.id, `${item.name} (${item.category || "Cardápio"})`, content, {
          itemId: item.id,
          category: item.category,
          priceCents: item.priceCents
        })
      );
    }
  }

  return chunks;
}
