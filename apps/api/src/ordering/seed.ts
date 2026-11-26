import type { BusinessProfile, CatalogItem, CatalogOptionGroup } from "./types.js";

function sizes(prefix: string): CatalogOptionGroup {
  return {
    id: `${prefix}-tamanho`,
    name: "Tamanho",
    required: true,
    minSelections: 1,
    maxSelections: 1,
    choices: [
      { id: `${prefix}-broto`, name: "Broto", priceCents: -1200 },
      { id: `${prefix}-media`, name: "Média", priceCents: 0 },
      { id: `${prefix}-grande`, name: "Grande", priceCents: 1500 }
    ]
  };
}

function crust(prefix: string): CatalogOptionGroup {
  return {
    id: `${prefix}-borda`,
    name: "Borda",
    required: false,
    minSelections: 0,
    maxSelections: 1,
    choices: [
      { id: `${prefix}-catupiry`, name: "Catupiry", priceCents: 800 },
      { id: `${prefix}-cheddar`, name: "Cheddar", priceCents: 800 }
    ]
  };
}

function pizza(id: string, name: string, description: string, priceCents: number): CatalogItem {
  return {
    id,
    name,
    description,
    priceCents,
    category: "Pizzas",
    available: true,
    optionGroups: [sizes(id), crust(id)]
  };
}

export const pizzariaProfile: BusinessProfile = {
  address: "Rua das Flores, 123",
  serviceArea: "Centro e bairros vizinhos, até 5 km.",
  hours: "Todos os dias, das 18h às 23h.",
  deliveryEnabled: true,
  pickupEnabled: true,
  deliveryFeeCents: 800,
  paymentMethods: ["Dinheiro", "Cartão", "Pix"],
  policies: "O pedido só é confirmado depois do resumo e do SIM do cliente. Tempo médio de entrega: 40 a 60 minutos.",
  persona: "Fale como o balcão de uma pizzaria de bairro: curto, simpático, sem texto de anúncio."
};

export const pizzariaCatalog: CatalogItem[] = [
  pizza("margherita", "Pizza Margherita", "Molho, mussarela e manjericão.", 4500),
  pizza("calabresa", "Pizza Calabresa", "Calabresa, cebola e mussarela.", 4800),
  pizza("portuguesa", "Pizza Portuguesa", "Presunto, ovo, cebola, azeitona e mussarela.", 5200),
  pizza("quatro-queijos", "Pizza Quatro Queijos", "Mussarela, parmesão, provolone e gorgonzola.", 5400),
  pizza("frango", "Pizza Frango com Catupiry", "Frango desfiado e catupiry.", 5300),
  {
    id: "coca-lata",
    name: "Coca-Cola lata",
    description: "Lata 350 ml.",
    priceCents: 700,
    category: "Bebidas",
    available: true,
    optionGroups: []
  },
  {
    id: "coca-2l",
    name: "Coca-Cola 2 litros",
    description: "Garrafa 2 litros.",
    priceCents: 1400,
    category: "Bebidas",
    available: true,
    optionGroups: []
  },
  {
    id: "guarana-lata",
    name: "Guaraná lata",
    description: "Lata 350 ml.",
    priceCents: 650,
    category: "Bebidas",
    available: true,
    optionGroups: []
  },
  {
    id: "agua",
    name: "Água sem gás",
    description: "Garrafa 500 ml.",
    priceCents: 400,
    category: "Bebidas",
    available: true,
    optionGroups: []
  },
  {
    id: "suco-laranja",
    name: "Suco de laranja",
    description: "Copo de 400 ml.",
    priceCents: 900,
    category: "Bebidas",
    available: true,
    optionGroups: []
  }
];

export const barbeariaProfile: BusinessProfile = {
  address: "Avenida Central, 456",
  serviceArea: "Atendimento no salão.",
  hours: "Terça a sábado, das 9h às 19h.",
  deliveryEnabled: false,
  pickupEnabled: false,
  deliveryFeeCents: 0,
  paymentMethods: ["Dinheiro", "Cartão", "Pix"],
  policies: "Horários e reservas são combinados com uma pessoa.",
  persona: "Fale de forma breve e educada."
};
