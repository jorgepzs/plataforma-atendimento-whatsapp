# Gateway Cloudflare para webhook local

O gateway de desenvolvimento publica somente `POST /webhooks/meta` por meio de um túnel Cloudflare. Ele valida a assinatura do app Meta, encaminha a requisição assinada à API em `127.0.0.1:3000` e bloqueia o painel, a API e arquivos locais. O gateway e o launcher são ferramentas de desenvolvimento para Windows, não uma arquitetura de produção.

## Pré-requisitos

1. Configure os arquivos locais descritos em [credenciais Meta](credenciais-meta-local.md).
2. Inicie `npm run dev:local` em um terminal.
3. Gere o build da API para disponibilizar o gateway:

```powershell
npm run build --prefix apps/api
```

4. Coloque a versão de `cloudflared` aprovada pelo projeto em `work/runtime/cloudflared/cloudflared.exe`. O launcher confere o hash do executável antes de iniciá-lo.

## Quick Tunnel temporário

```powershell
npm run meta:tunnel
```

O launcher solicita uma URL temporária `trycloudflare.com`, testa isolamento, challenge e assinatura e só então mostra o callback. A URL muda após reiniciar o túnel e não é indicada para operação contínua.

## Túnel nomeado

Configure o hostname que já foi associado ao seu túnel e à zona DNS da sua conta Cloudflare:

```powershell
$env:META_WEBHOOK_HOSTNAME = "webhook.example.com"
npm run meta:tunnel:named
```

O valor é apenas um exemplo; substitua-o pelo seu hostname. Salve o token específico do túnel em `.env.cloudflare-tunnel.local` com o formato `TUNNEL_TOKEN=<token>`. O arquivo é ignorado pelo Git; o launcher passa o token ao processo `cloudflared` pelo ambiente, sem colocá-lo nos argumentos.

## Túnel gerenciado localmente

Use esta opção apenas se já tiver criado o túnel e a rota DNS na sua conta. Configure o mesmo `META_WEBHOOK_HOSTNAME` e salve o UUID do túnel e o caminho absoluto do arquivo de credenciais específico em `.cloudflare-tunnel-local-managed.local`:

```text
TUNNEL_ID=<uuid-do-tunel>
TUNNEL_CREDENTIALS_FILE=C:\caminho\protegido\<uuid-do-tunel>.json
```

Depois inicie:

```powershell
npm run meta:tunnel:local-managed
```

O launcher cria um arquivo de configuração temporário com somente o hostname especificado encaminhado a `http://127.0.0.1:3001`, seguido de uma regra final `404`. O arquivo é removido ao encerrar o processo. Não coloque `cert.pem`, tokens ou arquivos de credenciais no repositório.

## Operação e limites

- Mantenha `npm run dev:local` ativo enquanto o túnel estiver em execução.
- `Ctrl+C` no terminal do túnel encerra gateway e `cloudflared`; a API e o painel são encerrados separadamente.
- O preflight valida que a API está no demo SQLite e verifica que somente o gateway está exposto.
- Eventos de webhook desconhecidos podem receber `503` para que o provedor tente novamente até o canal ser associado.
- A saída do atendimento segue simulada. O túnel não configura o app Meta nem habilita envio WhatsApp.

Consulte a documentação oficial da Cloudflare sobre [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) e [configuração de ingress](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/).
