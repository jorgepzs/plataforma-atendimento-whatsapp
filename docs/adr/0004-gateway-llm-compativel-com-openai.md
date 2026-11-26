# ADR 0004: Gateway único de LLM compatível com OpenAI

- Status: aceito
- Data: 2026-11-26

## Contexto

O classificador do ADR 0003 fala só com o endpoint nativo do Ollama e devolve um índice de FAQ. OpenRouter e os servidores locais Ollama e LM Studio também expõem chat completions no formato OpenAI, em URLs diferentes. Manter dois clientes para o mesmo formato complicaria provedor, timeout e ferramentas.

## Decisão

Adicionar um gateway em `apps/api/src/llm` com um único cliente HTTP compatível com OpenAI. `LLM_PROVIDER=openrouter|local` escolhe o padrão de URL, a chave e os cabeçalhos. `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, timeout e retentativas completam a configuração. A empresa pode gravar um override de provedor, URL, modelo e chave; a chave não volta na API.

Quando o provedor é `openrouter`, o cliente envia `HTTP-Referer` e `X-Title`. Ferramentas vão no mesmo pedido. Se o servidor recusar tools, o cliente repete uma vez sem elas e usa o texto. Timeout, erro de rede ou HTTP não derrubam o worker: a política `LLM_FAILURE_ACTION` responde uma mensagem configurável, transfere para uma pessoa, ou faz as duas coisas.

O classificador do ADR 0003 permanece intacto. Se a empresa está em `local_ai` e esse classificador existe, ele tem prioridade e uma falha continua indo para a fila humana. O gateway entra nas demais mensagens de texto que não casam com a FAQ, não são saudação e não pedem ação humana. Texto livre do modelo só é enviado quando o gateway está ligado por ambiente. Sem `LLM_PROVIDER`, o atendimento anterior não muda.

IA local é para desenvolvimento e teste. Ela exige o computador do modelo ligado. Produção deve usar OpenRouter.

## Consequências

O processo sobe com qualquer um dos dois provedores só trocando o ambiente. Uma chave por empresa fica no SQLite do demo, junto dos outros segredos locais, e não é devolvida ao painel. O gateway ainda não tem worker próprio no PostgreSQL de produção; quem atende conversas hoje é o worker local, que passa a chamá-lo quando o ambiente está configurado.
