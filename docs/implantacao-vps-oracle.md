# Implantação em VPS Oracle Cloud Always Free (Linux sem Docker)

Este documento descreve a arquitetura e o procedimento para hospedar a plataforma em uma VPS Ubuntu no **Oracle Cloud Infrastructure (OCI) Always Free Tier (R$ 0/mês)** sem Docker, usando `systemd`, SQLite local e Caddy (HTTPS automático) ou Cloudflare Tunnel.

> **Aviso de segurança:** as contas padrão de demonstração (`AtendeLocal123!`) são públicas neste repositório. Nunca exponha o painel à internet com senhas padrão nem contorne as proteções do modo local.

## Limites atuais do aplicativo

- O atendimento completo usa **SQLite local** (`node:sqlite` do Node.js 22.13+), configurado via `LOCAL_SQLITE_PATH`, mantendo `DATABASE_URL` vazio.
- O código também possui um backend PostgreSQL unificado para atendimento, autenticação/sessões, fila inbound, Consumer e RAG. As migrações são testadas separadamente; este kit Oracle continua configurado para SQLite e não foi implantado nem validado em uma VPS real.
- O modo de demonstração (`ENABLE_LOCAL_DEMO=true`) exige `NODE_ENV` diferente de `production` e `API_HOST` em loopback. O canal WhatsApp pode usar SQLite ou PostgreSQL, com `WHATSAPP_SESSION_DIR`; o envio de teste Cloud API permanece restrito à demonstração local.
- Os launchers de desenvolvimento em `scripts/` têm rotinas voltadas para o ambiente local no Windows; na VPS Linux, a execução é controlada diretamente pelo `systemd` (`infra/oracle/atende-api.service`).

## Recursos Oracle Cloud Always Free (R$ 0/mês)

| Recurso | Configuração recomendada (Always Free) | O que evitar (gera cobrança) |
| --- | --- | --- |
| Compute | `VM.Standard.A1.Flex` (Ampere ARM64, até 4 OCPU / 24 GB RAM) ou `VM.Standard.E2.1.Micro` (AMD64, 1/8 OCPU / 1 GB RAM + swap 2 GB) | Shapes pagos (`E4.Flex`, `E5.Flex`, etc.) |
| Sistema | Ubuntu 22.04 LTS ou Ubuntu 24.04 LTS | Imagens pagas de marketplace |
| Disco | Boot volume padrão (~47 GB, dentro da cota de 200 GB Always Free) | OCI Volume Backup pago / volumes extras > 200 GB |
| Banco | SQLite local em `/var/lib/plataforma-atendimento/attendance.sqlite` com backup diário comprimido (7 dias) | Autonomous DB ou PostgreSQL gerenciado |
| Proxy / TLS | Caddy local com Let's Encrypt automático **ou** Cloudflare Tunnel gratuito | OCI Load Balancer pago |
| Rede | 1 IPv4 público + até 10 TB/mês de egress Always Free | NAT Gateway / FastConnect |

## Topologias suportadas

### 1. Demonstração privada (zero exposição pública do painel)

```text
Navegador -- túnel SSH (-L 5173/3000) --> painel e API em 127.0.0.1:3000
                                                |
                                          SQLite local

Meta --> Cloudflare Tunnel (cloudflared) --> /webhooks/* em 127.0.0.1:3000
```

Mantenha o painel, a API e o SQLite acessíveis apenas em loopback. Publique pelo Cloudflare Tunnel somente a rota `/webhooks/*` em um subdomínio dedicado (ex.: `webhook.seudominio.com`), com fallback final `404`.

### 2. Acesso HTTPS via Caddy (após hardening de autenticação e troca de senhas)

```text
Internet (HTTPS 443) --> Caddy (auto-TLS Let's Encrypt)
                           ├── /api/*      --> 127.0.0.1:3000 (SSE flush_interval -1 + WS)
                           ├── /health/*   --> 127.0.0.1:3000
                           ├── /webhooks/* --> 127.0.0.1:3000
                           └── /*          --> /opt/plataforma-atendimento/apps/web/dist
```

Defina `WHATSAPP_PANEL_ORIGINS=https://seu-dominio.com` em `/etc/plataforma-atendimento/api.env` para que a validação de origem do painel aceite o domínio público.

## Kit de provisionamento (`infra/oracle/`)

O kit pronto para uso está em [`infra/oracle/`](../infra/oracle/README.md):

- [`infra/oracle/bootstrap-vps.sh`](../infra/oracle/bootstrap-vps.sh): script idempotente para Ubuntu 22.04/24.04 (`arm64` e `amd64`) que cria swap de 2 GB, instala Node.js 22 LTS (`>=22.13`), `git`, `sqlite3`, `caddy` (ou `cloudflared`), cria o usuário sem privilégios `atende`, libera 80/443 com segurança tanto no `iptables` da OCI (`netfilter-persistent`) quanto no `ufw` sem travar a porta SSH 22, limita o tamanho do `journald`, instala o serviço `systemd` e agenda backups diários comprimidos do SQLite com retenção de 7 dias.
- [`infra/oracle/deploy-remote.ps1`](../infra/oracle/deploy-remote.ps1): script PowerShell para executar a implantação completa a partir do Windows via `ssh`/`scp`/`tar` nativos.
- [`infra/oracle/Caddyfile.oracle`](../infra/oracle/Caddyfile.oracle): configuração do Caddy com auto-TLS, suporte a SSE/WebSocket e bloco documentado para Cloudflare Tunnel.
- [`infra/oracle/atende-api.service`](../infra/oracle/atende-api.service): unidade `systemd` endurecida com `MemoryMax`, `ProtectSystem=strict` e `Restart=on-failure`.
- [`infra/oracle/env.oracle.example`](../infra/oracle/env.oracle.example): modelo de variáveis para `/etc/plataforma-atendimento/api.env`.

## Resumo do fluxo de implantação

1. Criar a VM Always Free na OCI (Ubuntu 22.04/24.04, `A1.Flex` ou `E2.1.Micro`) e liberar na **VCN Security List** apenas as portas necessárias (`22` sempre; `80`/`443` apenas se usar Caddy público; nenhuma porta web se usar Cloudflare Tunnel; **nunca** a porta `3000`).
2. Configurar o DNS (`A` apontando para o IP público da VM) ou criar o túnel gratuito no Cloudflare Zero Trust.
3. Preparar o arquivo de ambiente fora do repositório com base em `infra/oracle/env.oracle.example`.
4. Executar `infra/oracle/deploy-remote.ps1` no PowerShell informando `-VpsHost`, `-SshUser ubuntu` e `-KeyPath`.
5. Validar `http://127.0.0.1:3000/health/live`, `http://127.0.0.1:3000/health/ready`, isolamento da porta `3000`, `systemctl status atende-api caddy` e o timer de backup `atende-backup.timer`.

Para o passo a passo detalhado, comandos de restauração de backup e checklists da OCI, consulte [`infra/oracle/README.md`](../infra/oracle/README.md).
