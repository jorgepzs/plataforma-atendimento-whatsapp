# Configurar credenciais Meta para desenvolvimento local

Este guia descreve arquivos locais usados pelos utilitários de desenvolvimento. Eles não configuram autenticação de produção e não habilitam o envio de mensagens.

## Arquivos locais

Use os modelos versionados como referência e mantenha valores reais somente em arquivos ignorados pelo Git:

- `.env.meta.local` para identificadores e token de acesso de um número de teste.
- `.env.webhook.local` para o segredo do app Meta e o token de verificação do webhook.

Não copie os arquivos locais para commits, capturas de tela ou chats. Eles são arquivos de texto; restrinja o acesso no computador e use tokens com o menor escopo necessário. Os exemplos `.env.meta.example` e `.env.webhook.example` não contêm credenciais ativas.

## Verificação offline

```powershell
npm run meta:check-local
npm run meta:check-webhook
```

Esses comandos validam a estrutura dos arquivos sem imprimir os valores. Eles não confirmam validade, permissões, expiração ou disponibilidade de recursos na Meta.

## Consulta opcional somente leitura

```powershell
npm run meta:verify-channel
```

Esse comando faz um `GET` autenticado à API da Meta para consultar o vínculo do número de teste. Ele não envia mensagens nem altera configurações. Um resultado positivo não confirma permissão de envio nem entrega futura.

O modo de atendimento local mantém as respostas como `SIMULATED`. O adaptador Cloud API é uma opção separada, limitada à demonstração em SQLite/loopback e desligada por padrão. Consulte o [contrato de saída](contrato-saida-whatsapp.md) antes de alterar essa configuração.
