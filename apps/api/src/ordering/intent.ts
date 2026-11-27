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

const historicalOrderInquiryPatterns = [
  /\b(?:qual|quais|como|quanto|cade|mostra|me mostra|me diga|me fala|consulta|consultar|ver)\b.{0,40}\b(?:meu|minha|o|a)?\s*(?:ultimo|anterior|passado)\s+(?:pedido|encomenda)\b/,
  /\b(?:qual|quais|como|quanto|cade|mostra|me mostra|me diga|me fala|consulta|consultar|acompanhar|rastrear|status|andamento|foi|ver)\b.{0,60}\b(?:pedido|encomenda)\b.{0,60}\b(?:ontem|anteontem|anterior|passado|ultima vez|ultimo|historico)\b/,
  /\b(?:pedido|encomenda)\b.{0,60}\b(?:ontem|anteontem|anterior|passado|ultima vez|ultimo|historico)\b.{0,50}\b(?:status|andamento|consulta|consultar|acompanhar|rastrear|qual|quanto|foi|mostrar|ver)\b/
];

const historicalOrderRepeatPatterns = [
  /\b(?:repete|repita|repetir|refazer|fazer de novo|faz de novo)\b.{0,45}\b(?:(?:meu|minha|o|a)\s+)?(?:ultimo pedido|pedido(?:\s+de\s+(?:ontem|anteontem))?|pedido anterior)\b/,
  /\b(?:quero|gostaria|preciso|vou|manda|mande|faz|faca)\b.{0,40}\b(?:o mesmo|a mesma|igual ao|igual a|igual)\b.{0,50}\b(?:ontem|anteontem|anterior|passado|ultima vez|ultimo pedido|pedido anterior)\b/,
  /\b(?:pedir|fazer|repetir|repita|repete|refazer|mandar|enviar)\b.{0,40}\b(?:igual|mesmo)\b.{0,50}\b(?:ontem|anteontem|anterior|passado|ultima vez|ultimo pedido|pedido anterior)\b/,
  /\b(?:repete|repita|repetir|refazer)\b.{0,40}\b(?:o pedido|a pizza|a ultima|o ultimo|igual)\b.{0,60}\b(?:ontem|anteontem|anterior|passado|ultima vez|ultimo pedido|pedido anterior)\b/,
  /\b(?:repete|repita|repetir|fazer de novo)\b.{0,40}\b(?:a ultima|o ultimo|igual)\b.{0,40}\b(?:pizza|pedido|encomenda)\b/
];

export function isHistoricalOrderInquiry(text: string): boolean {
  const normalized = normalizeText(text);
  return isHistoricalOrderRepeatRequest(normalized) || historicalOrderInquiryPatterns.some((pattern) => pattern.test(normalized));
}

export function isHistoricalOrderRepeatRequest(text: string): boolean {
  const normalized = normalizeText(text);
  return historicalOrderRepeatPatterns.some((pattern) => pattern.test(normalized));
}

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
