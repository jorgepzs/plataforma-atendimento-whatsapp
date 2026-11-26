import type { CatalogItem } from "./types.js";
import { normalizeText } from "./text.js";

const schedulingPatterns = [
  /\b(?:quero|gostaria|preciso|pode|poderia|me ajuda a|me ajude a)\b.{0,60}\b(?:reserva|reservar|agendar|agendamento|marcar|remarcar|reagendar)\b/,
  /\b(?:reservar|reserve|agendar|agende|marcar|marque|remarcar|reagendar|cancelar|cancele)\b.{0,60}\b(?:mesa|horario|atendimento|corte|barba)\b/,
  /\b(?:tem|ha|haveria|teria|consegue|pode|poderia)\b.{0,50}\bmesa\b/,
  /\b(?:tem|ha|haveria|teria|consegue|pode|poderia)\b.{0,50}\bhorario\b.{0,35}\b(?:disponivel|livre|vaga|corte|barba|marcar|agendar|reservar|fazer|cortar)\b/,
  /\b(?:horarios? disponiveis|horarios? livres|disponibilidade)\b/,
  /\b(?:me encaixa|consegue me encaixar|queria um horario)\b/,
  /\b(?:quero|gostaria|preciso|pode|poderia|me ajuda a|me ajude a)\b.{0,60}\b(?:orcamento|cotacao)\b/,
  /\b(?:solicitar|preparar|fazer|faca|fazem|faz|montam|montar|passar|me passar)\s+(?:um\s+)?(?:orcamento|cotacao)\b/,
  /\b(?:cancelar|cancele)\b.{0,40}\b(?:reserva|agendamento|horario)\b/
];

const orderPatterns = [
  /\b(?:quero|gostaria|preciso|pode|poderia|me ajuda a|me ajude a)\b.{0,80}\b(?:pedir|encomendar|comprar|pedido)\b/,
  /\b(?:fazer|faco|montar|colocar|enviar|realizar|acompanhar|alterar|cancelar)\s+(?:(?:um|o|meu|minha)\s+)?(?:pedido|encomenda)\b/,
  /\b(?:pedido|encomenda)\b.{0,40}\b(?:entrega|delivery|retirada|retirar|acompanhar|alterar|cancelar)\b/,
  /\b(?:cardapio|pizza|pizzas|refrigerante|coca|guarana|bebida|suco)\b/
];

const confirmationPattern = /^(?:sim|confirmo|confirmado|pode confirmar|confirma|ok confirma|pode fechar|fechado|isso mesmo|esta certo|ta certo|pode mandar|manda)$/;

export function isSchedulingOrQuote(text: string): boolean {
  const normalized = normalizeText(text);
  return schedulingPatterns.some((pattern) => pattern.test(normalized));
}

export function isOrderIntent(text: string): boolean {
  const normalized = normalizeText(text);
  return orderPatterns.some((pattern) => pattern.test(normalized));
}

export function textMentionsItem(text: string, catalog: readonly CatalogItem[]): boolean {
  const normalized = normalizeText(text);
  return catalog.some((item) => {
    if (!item.available) return false;
    const name = normalizeText(item.name);
    if (name.length >= 3 && normalized.includes(name)) return true;
    return name.split(" ").some((token) => token.length >= 5 && normalized.includes(token));
  });
}

export function isExplicitOrderConfirmation(text: string): boolean {
  const normalized = normalizeText(text).replace(/[!?.]+$/g, "").trim();
  return confirmationPattern.test(normalized);
}

export function isOrderCancellation(text: string): boolean {
  const normalized = normalizeText(text);
  return /\b(?:cancelar|cancele|cancela)\b/.test(normalized) && /\b(?:pedido|encomenda)\b/.test(normalized);
}
