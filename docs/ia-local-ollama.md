# Classificação local de FAQ com Ollama

## Escopo

O seletor local ajuda a identificar qual resposta previamente aprovada pode responder à mensagem. O modelo não redige a resposta ao consumidor, não executa ferramentas e não confirma pedidos, reservas ou agendamentos. Sem uma escolha segura, o fluxo encaminha a conversa para uma pessoa.

## Fluxo e limites

1. Mensagens sem texto, mídia e pedidos de atendimento humano seguem diretamente para `WAITING_HUMAN`.
2. Saudações e correspondências exatas com a FAQ usam as respostas configuradas sem consultar o modelo.
3. Se o modo local estiver habilitado no servidor e selecionado pela empresa, o classificador recebe somente segmento, nome comercial, FAQ aprovada e mensagem atual.
4. O modelo retorna uma decisão estruturada (`match` ou `handoff`) e um índice. A API envia apenas o texto literal da resposta cadastrada.
5. Modelo ausente, timeout, resposta inválida ou falta de correspondência resultam em atendimento humano.

O adaptador usa `http://127.0.0.1:11434/api/chat`, sem redirecionamentos ou retries, com timeout e limite de resposta. Ele não aceita host definido pelo painel nem envia conteúdo a um serviço remoto.

## Configuração

O recurso vem desligado por padrão. Em um ambiente local com Ollama e um modelo já instalados, configure o arquivo privado `.env`:

```dotenv
ENABLE_LOCAL_DEMO=true
API_HOST=127.0.0.1
LOCAL_AI_ENABLED=true
LOCAL_AI_MODEL=<nome-do-modelo-instalado>
```

Com `dev:local`, as configurações `LOCAL_AI_*` são herdadas do ambiente. Um administrador local também precisa selecionar IA local na configuração da empresa. O padrão continua sendo FAQ aprovada sem IA.

Não exponha a porta Ollama `11434` à internet nem a inclua em um túnel. O conteúdo de mensagens pode ser pessoal; limite o processamento ao host autorizado.

## Smoke local

Com Ollama ativo em `127.0.0.1:11434` e o modelo configurado, execute:

```powershell
npm run test:ollama:smoke
```

O smoke compila a API e exercita mensagens sintéticas em memória. Não abre a porta da aplicação, não altera o banco local e não envia mensagens externas. Os testes regulares do classificador usam transporte controlado.

Consulte a documentação oficial da [API de chat](https://docs.ollama.com/api/chat) e de [saídas estruturadas](https://docs.ollama.com/capabilities/structured-outputs).
