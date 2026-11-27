# Estado de guardrails, RAG e PostgreSQL

Atualizado em 27/11/2026. Esta página descreve o estado observado neste checkout; “implementado” não significa pronto para produção.

## Implementado

- **Objetivo do assistente:** o painel salva um objetivo por empresa, como montar pedidos ou orientar um orçamento. A API valida o texto, e o prompt o mantém subordinado às regras de preço, confirmação e segurança.
- **Guardrails:** proteção de entrada, endurecimento do prompt, validação de ferramentas, inspeção da resposta, restrição a preços cadastrados e bloqueio de falsa confirmação estão integrados ao gateway de IA.
- **RAG híbrido:** a API indexa perfil, políticas, FAQ e catálogo por tenant. SQLite persiste chunks e embeddings; usa ranking lexical determinístico. PostgreSQL usa FTS em português. Embeddings são opcionais e adicionam ranking vetorial quando configurados.
- **Configuração:** `RAG_ENABLED`, `RAG_EMBEDDING_PROVIDER`, `RAG_EMBEDDING_BASE_URL`, `RAG_EMBEDDING_API_KEY`, `RAG_EMBEDDING_MODEL`, `RAG_TOP_K_CATALOG`, `RAG_TOP_K_KNOWLEDGE` e `RAG_TIMEOUT_MS` aparecem no `.env.example`, no exemplo Oracle e no Compose.
- **Formulários:** o editor de itens não cria mais `<form>` dentro do formulário de configurações; há teste de regressão que verifica um único formulário.
- **ElevenLabs:** integração descartada e não incluída. A migração SQLite v11 mantém o identificador histórico como no-op: não cria as tabelas antigas e não apaga tabelas de bancos existentes.
- **Launcher local:** `dev:local` continua em SQLite por padrão. `dev:postgres` é explícito e aceita somente URL de PostgreSQL em loopback.

## Validação

- As migrações `001_initial.sql`, `002_customer_orders.sql` e `004_unified_postgres_and_rag.sql` foram aplicadas com sucesso em um PostgreSQL 16 descartável iniciado localmente. A verificação confirmou as seis tabelas principais do backend unificado e a coluna FTS `search_vector` do RAG. O banco e o container temporários foram removidos ao final.
- O teste `postgres-unified.test.ts` usa um pool falso em memória; ele não é uma prova de operação completa da aplicação contra PostgreSQL real.
- As rotas de API do atendimento estão conectadas ao backend PostgreSQL, mas o bootstrap do painel web ainda só libera login quando `localDemoEnabled` está ligado. A navegação visual completa usando PostgreSQL permanece pendente.
- `npm run check` passou: typecheck e builds da API/web, 259 testes da API, 13 do painel e 41 testes offline dos scripts (313 no total).
- O kit Oracle está documentado, mas não foi executado em uma VPS. Compose, provisionamento, backups e operação de produção continuam sem validação de ponta a ponta.

## Limites conhecidos

- Sem embeddings, o RAG usa busca lexical; a busca semântica vetorial depende de um provedor compatível configurado e disponível.
- O teste real desta etapa validou o executor e o SQL das migrações, não disponibilidade, recuperação, backup, desempenho ou comportamento sob concorrência em um ambiente de produção.
- O backend não semeia nem aceita as contas padrão de demonstração em `NODE_ENV=production` e invalida sessões de demonstração restauradas. Ainda não há fluxo de provisionamento de usuários reais; autenticação, cadastro de canais e operação continuam pendentes antes do atendimento de clientes reais.
