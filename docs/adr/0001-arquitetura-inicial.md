# ADR 0001: Arquitetura inicial da plataforma

- Data: 2026-10-03
- Status: aceita como direção do MVP; implementação parcial

## Contexto

A especificação define um produto multicliente de atendimento por WhatsApp que deve servir negócios diferentes sem assumir funções de ERP. O MVP precisa manter operação simples e econômica, aceitar clientes sem integrações e permitir evolução para IA local, fila humana e conectores. A primeira base existente contém uma API Fastify/TypeScript, stores de eventos em memória/PostgreSQL, lógica de webhook Meta, funções de domínio e compose com PostgreSQL e Caddy.

## Decisões

1. Usar monólito modular no MVP. Separar domínio, portas, infraestrutura, serviços e rotas, adiando microserviços.
2. Usar PostgreSQL para persistência e, no desenho futuro, filas/jobs com padrões transacionais; Redis não será obrigatório.
3. Separar o núcleo conversacional de capacidades tipadas (conhecimento, coleta e handoff) e conectores opcionais.
4. Identificar tenant pelo `phone_number_id` validado da Meta e canal cadastrado. Nunca confiar em tenant indicado pelo consumidor.
5. Receber webhooks oficialmente pela WhatsApp Cloud API, validar assinatura e deduplicar eventos pelo identificador externo.
6. Manter política de envio com bloqueio padrão de mensagens potencialmente pagas/proativas.
7. Usar painel web responsivo/PWA e SSE como direção para a fila humana; usar gateway de IA para permitir diferentes modelos e execução local.
8. Tratar casos de atendimento como organização do trabalho humano. Pedidos, agenda ou outras operações confirmadas pertencem ao sistema externo quando existir.

## Alternativas consideradas

- Microserviços desde o início: rejeitados para o MVP por aumentarem componentes e custo operacional.
- Redis como dependência obrigatória: rejeitado para reduzir serviços; PostgreSQL é a opção prevista para filas.
- Acoplar a plataforma a um segmento ou sistema operacional: rejeitado para manter um núcleo conversacional reutilizável.
- Automação não oficial de WhatsApp: rejeitada em favor da Cloud API oficial.

## Consequências

A implantação inicial pode manter poucos serviços e evoluir por módulos. PostgreSQL torna-se dependência de persistência e deverá ter migrações, backups e proteção de concorrência. Os conectores e a IA precisam ser isolados por contratos e políticas do backend. O escopo deixa claro que a plataforma facilita o atendimento e não é fonte de verdade para operações externas.

## Estado de implementação observado

Implementados parcialmente: API Fastify, health checks, endpoint de informação do sistema, verificação e recebimento de webhook, normalização, stores de evento em memória e PostgreSQL, migração SQL do esquema inicial, funções de estado e política de custo, painel web inicial e testes de domínio/configuração/rotas, compose de PostgreSQL/API/Caddy.

O painel oferece somente visão geral e não tem autenticação nem operações reais de atendimento. O webhook grava eventos, mas não há worker, processamento conversacional ou envio real pelo WhatsApp. Também estão ausentes SSE, orquestrador, workflows, gateway de IA, capacidades e conectores. A especificação descreve esses componentes como visão/plano, não como entrega já concluída.
