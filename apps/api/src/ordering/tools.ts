import type { LlmTool } from "../llm/openai-chat-client.js";

const object = "object";

export const orderingTools: readonly LlmTool[] = [
  {
    name: "get_catalog",
    description: "Lista o cardápio com ids, preços calculáveis e opções. Use antes de inventar qualquer item.",
    parameters: { type: object, additionalProperties: false, properties: {} }
  },
  {
    name: "search_catalog",
    description: "Busca itens do cardápio por nome ou categoria.",
    parameters: {
      type: object,
      additionalProperties: false,
      properties: { query: { type: "string" } }
    }
  },
  {
    name: "add_item",
    description: "Adiciona um item do cardápio ao rascunho. O servidor calcula o preço. Não envie preço.",
    parameters: {
      type: object,
      additionalProperties: false,
      properties: {
        itemId: { type: "string" },
        quantity: { type: "integer" },
        choiceIds: { type: "array", items: { type: "string" } }
      },
      required: ["itemId"]
    }
  },
  {
    name: "update_item",
    description: "Altera quantidade ou opções de uma linha do rascunho.",
    parameters: {
      type: object,
      additionalProperties: false,
      properties: {
        lineId: { type: "string" },
        quantity: { type: "integer" },
        choiceIds: { type: "array", items: { type: "string" } }
      },
      required: ["lineId"]
    }
  },
  {
    name: "remove_item",
    description: "Remove uma linha do rascunho.",
    parameters: {
      type: object,
      additionalProperties: false,
      properties: { lineId: { type: "string" } },
      required: ["lineId"]
    }
  },
  {
    name: "set_fulfillment",
    description: "Define entrega ou retirada. Entrega exige endereço.",
    parameters: {
      type: object,
      additionalProperties: false,
      properties: {
        method: { type: "string", enum: ["delivery", "pickup"] },
        address: { type: "string" },
        notes: { type: "string" }
      },
      required: ["method"]
    }
  },
  {
    name: "get_order_summary",
    description: "Calcula o total no servidor e marca o pedido como aguardando a confirmação do cliente.",
    parameters: { type: object, additionalProperties: false, properties: {} }
  },
  {
    name: "confirm_order",
    description: "Fecha o pedido somente depois que o cliente confirmou o resumo explicitamente, por exemplo com SIM.",
    parameters: { type: object, additionalProperties: false, properties: {} }
  },
  {
    name: "transfer_to_human",
    description: "Encaminha para uma pessoa quando falta informação, o cliente pede um humano, ou o assunto é reserva, agendamento ou orçamento.",
    parameters: {
      type: object,
      additionalProperties: false,
      properties: { reason: { type: "string" } }
    }
  }
];

export const transferTool: LlmTool = orderingTools[orderingTools.length - 1]!;
