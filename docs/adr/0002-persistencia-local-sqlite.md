# ADR 0002 — Persistência local sem Docker

Data: 2026-10-03. Status: implementada e validada para desenvolvimento local.

## Contexto

O usuário quer avançar sem custo, Docker, virtualização ou reinício do Windows. A política de Controle de Aplicativo bloqueia `pg_ctl.exe` da distribuição PostgreSQL oficial. Não há autorização para contornar essa proteção. O demo em memória perderia configurações e atendimentos ao encerrar a API.

## Decisão

Usar SQLite embarcado em `node:sqlite`, já disponível no Node 22.23.2 instalado. Não adicionar biblioteca nativa ou servidor. `dev:local` usa `.data/attendance.sqlite`; `dev:memory` mantém a alternativa volátil. SQLite está restrito a demonstração explícita, loopback, fora de produção e sem `DATABASE_URL`.

Persistir tenants, configurações versionadas, conversas, mensagens, deduplicação, fila inbound, usuários/memberships e sessões. Armazenar hashes de senha e de cookie, nunca senha ou cookie em claro. Criação de tenant e membership do criador usa uma transação. Reverter também os mapas em memória se houver falha.

Evento inbound fica em fila durável, com lease de 30 segundos, backoff e até cinco tentativas. Persistir efeitos e ID processado antes de confirmar o evento. Replay após falha entre commit e ACK não pode duplicar mensagens. Um lock de writer impede processos concorrentes; recuperar somente quando o PID anterior morreu.

## Consequências e limites

O [módulo SQLite desta versão do Node](https://nodejs.org/download/release/v22.23.2/docs/api/sqlite.html) é experimental e síncrono. Repositórios salvam snapshots completos: custo O(total de dados), adequado ao demo, não ao crescimento em produção. Este modo suporta um processo, não múltiplos workers. Rate limit de login ainda é volátil. Banco e exportações contêm dados sensíveis; `.gitignore` não oferece criptografia ou controle de acesso. A autenticação com contas públicas demo não pode ser exposta na internet.

PostgreSQL permanece a arquitetura prevista para a VPS. Essa implementação não valida o esquema PostgreSQL, o Compose, autenticação de produção, backup operacional, auditoria ou retenção. Não há IA ou envio WhatsApp: saídas do painel são `SIMULATED`.

## Verificação

Testes de reabertura, rollback, sessões/logout, isolamento de tenants, fila/retry e writer lock; smoke integrado em banco temporário separado. Reinício real da API também foi conferido no navegador, mantendo sessão, configuração e histórico. Dados do demo anterior foram exportados e importados antes de encerrar o processo; sessões e deduplicação do processo antigo não eram acessíveis pela API de exportação e não foram migradas.

Consulte `PROJECT_CONTEXT.md` para a contagem final dos testes e o ponto exato de continuidade. Nenhum processo de teste deve usar o banco real do usuário.
