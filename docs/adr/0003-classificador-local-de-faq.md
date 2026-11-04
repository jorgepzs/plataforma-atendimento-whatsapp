# ADR 0003: Classificador local restrito à FAQ aprovada

- Status: aceito e validado para o demo local; produção pendente.
- Data: 2026-10-03.

## Contexto

O primeiro atendimento só entendia uma pergunta se ela fosse literalmente igual à pergunta cadastrada. O usuário quer IA sem cobrança de API e mantém envio ao WhatsApp simulado; o Oracle/VPS ainda não está acessível.

## Decisão

Adicionar uma porta `KnowledgeAnswerSelector` com adaptador opcional Ollama. O modo local é desativado por padrão, restrito a `ENABLE_LOCAL_DEMO` fora de produção e API loopback. O painel grava `assistantMode` por tenant. O adaptador usa endpoint Ollama fixo em loopback e retorna apenas um índice de FAQ aprovada ou handoff. A aplicação entrega somente o texto literal da resposta configurada; nunca envia texto livre produzido pelo modelo. Falha, timeout, saída inválida ou falta de match levam à fila humana. A entrada não inclui telefone, nome, histórico ou dados de outro tenant. Pedidos operacionais de pedido/compra, reserva/agendamento e orçamento passam por um filtro determinístico de encaminhamento humano antes do modelo, para uma FAQ relacionada não ser confundida com autorização para executar a ação.

## Consequências

- O seletor pode entender paráfrases sem gerar fatos/respostas novas; as FAQs precisam ser mantidas pelo administrador de cada empresa. A seleção probabilística não substitui regras determinísticas para ações que exigem uma pessoa.
- Ollama/modelo consomem CPU, memória e disco do host. Neste PC, Ollama 0.35.1 e qwen2.5:1.5b foram instalados e validados por smoke sintético; servidor e inicialização automática ficaram desligados após o teste. O .env privado habilita IA apenas para o demo deste host, enquanto o .env.example permanece desativado.
- O seletor não está ligado ao backend PostgreSQL/produção e não habilita envio Cloud API.
- Testes automatizados usam transporte falso e cobrem segurança/fallback; `npm run test:ollama:smoke` valida opcionalmente a integração real com respostas sintéticas em memória, sem abrir porta de API nem enviar mensagens.

## Referências

- [Contrato de IA local com Ollama](../ia-local-ollama.md)
- [API oficial de chat do Ollama](https://docs.ollama.com/api/chat)
- [Structured outputs do Ollama](https://docs.ollama.com/capabilities/structured-outputs)
