# Kit de Implantação — Oracle Cloud Always Free Tier (R$ 0/mês)

> **Estado em 27/11/2026:** os scripts e instruções deste kit estão preparados, mas ainda não foram executados em uma VPS real. O kit configura o modo SQLite local; a API também possui backend PostgreSQL unificado, cujas migrações foram verificadas em um PostgreSQL descartável, sem validar deploy, backup ou operação PostgreSQL na OCI.

Este diretório contém o kit completo e enxuto para provisionar e implantar a **Plataforma de Atendimento WhatsApp** em uma VPS Ubuntu no **Oracle Cloud Infrastructure (OCI) Always Free Tier**, mantendo o custo mensal em **R$ 0**.

## Arquivos deste kit

| Arquivo | Finalidade |
| --- | --- |
| `bootstrap-vps.sh` | Script idempotente para Ubuntu 22.04/24.04 (`arm64` e `amd64`): swap 2 GB, Node.js 22 LTS, SQLite, Caddy (ou `cloudflared`), usuário `atende`, firewall (`iptables` OCI + `ufw` sem travar SSH), limites de `journald`, `systemd` e backup diário comprimido do SQLite com retenção de 7 dias. |
| `deploy-remote.ps1` | Script PowerShell para rodar a partir do Windows (usando `ssh`, `scp` e `tar` nativos): empacota o código limpo, envia para a VPS, executa o bootstrap, compila API + Web, instala `.env` com segurança e valida `/health/live` e `/health/ready`. |
| `Caddyfile.oracle` | Proxy reverso minimalista com HTTPS automático (Let's Encrypt), estáticos de `apps/web/dist`, proxy para `127.0.0.1:3000` (com `flush_interval -1` para SSE e suporte a WebSocket) e guia alternativo para **Cloudflare Tunnel**. |
| `atende-api.service` | Unidade `systemd` endurecida (`User=atende`, `ProtectSystem=strict`, `MemoryMax`, `Restart=on-failure`). |
| `env.oracle.example` | Modelo de variáveis de ambiente para `/etc/plataforma-atendimento/api.env` (`chmod 640`, `root:atende`). |

---

## Checklist para ficar estritamente em R$ 0/mês na OCI

### 1. Criação da instância Compute (Always Free)

No console da Oracle Cloud (`Compute → Instances → Create Instance`):

1. **Image**: `Ubuntu 22.04` ou `Ubuntu 24.04` (Minimal ou Standard).
2. **Shape** (verifique sempre o selo **Always Free-eligible** antes de clicar em Create):
   - **Opção recomendada — Ampere ARM (`VM.Standard.A1.Flex`)**: até **4 OCPU e 24 GB de RAM** somados no tenancy (ex.: crie com `2 OCPU / 12 GB RAM` ou `4 OCPU / 24 GB RAM`). Compila e roda Node.js + Baileys com folga.
     - *Nota*: em regiões concorridas (como São Paulo / Vinhedo), contas Free Trial podem retornar `Out of host capacity` para A1.Flex. Alternativas gratuitas: tentar outro Availability Domain, usar `VM.Standard.E2.1.Micro`, ou migrar a conta para *Pay As You Go* mantendo estritamente recursos marcados como *Always Free* (com alerta de orçamento de R$ 1).
   - **Opção alternativa — AMD (`VM.Standard.E2.1.Micro`)**: `1/8 OCPU / 1 GB RAM` (até 2 instâncias Always Free). Funciona com o **swap de 2 GB** e limite de heap configurados automaticamente por `bootstrap-vps.sh` e `deploy-remote.ps1`.
3. **Networking**:
   - Atribuir **Public IPv4 address** (ephemeral ou 1 IP reservado Always Free).
   - **NÃO** criar *OCI Load Balancer* (o Caddy na própria VM já faz TLS automático gratuito).
4. **Add SSH keys**:
   - Baixe a chave privada (`.key`) ou cole sua chave pública (`id_ed25519.pub`).
   - No Windows, guarde a chave em `%USERPROFILE%\.ssh\oracle-vps.key` com permissões restritas apenas ao seu usuário.
5. **Boot Volume**:
   - Deixe o padrão (~47 GB) ou no máximo dentro da cota total de **200 GB Always Free** de Block Volume do tenancy (não marque backups pagos do OCI Volume Backup; usamos backup SQLite comprimido local + download opcional).
6. **Banco de dados**:
   - Use o **SQLite local** já integrado ao Node 22 (`LOCAL_SQLITE_PATH=/var/lib/plataforma-atendimento/attendance.sqlite`). **NÃO** crie Autonomous Database ou serviço gerenciado pago.
7. **Tráfego de rede**:
   - A OCI inclui **10 TB/mês de egress gratuito**, muito acima do tráfego de atendimento WhatsApp + painel.

---

### 2. Regras de Ingress na VCN (Security List)

Em `Networking → Virtual Cloud Networks → <sua VCN> → Public Subnet → Default Security List → Ingress Rules`:

| Modo | Source CIDR | Protocol | Destination Port | Motivo |
| --- | --- | --- | --- | --- |
| Todos | `<SEU_IP>/32` (ou `0.0.0.0/0`) | TCP | `22` | Acesso administrativo SSH |
| Caddy (auto-TLS) | `0.0.0.0/0` | TCP | `80` | Desafio ACME Let's Encrypt + redirecionamento HTTPS |
| Caddy (auto-TLS) | `0.0.0.0/0` | TCP | `443` | Painel web HTTPS e webhooks |
| Caddy (auto-TLS) | `0.0.0.0/0` | UDP | `443` | HTTP/3 (QUIC) opcional do Caddy |
| Cloudflare Tunnel | *(não abrir 80/443)* | — | — | Túnel outbound de saída; zero portas web abertas |

> **Regra de ouro**: **nunca** abra a porta `3000` na Security List. A API escuta apenas em `127.0.0.1:3000`.

> **Atenção ao firewall interno da imagem Ubuntu da Oracle**: imagens oficiais da OCI vêm com uma regra `REJECT` padrão no `iptables` (`/etc/iptables/rules.v4`) que bloqueia 80/443 mesmo quando a Security List está aberta. O script `bootstrap-vps.sh` insere as regras de liberação **acima** do `REJECT`, salva via `netfilter-persistent` e configura o `ufw` garantindo que a porta `22` permaneça aberta.

---

### 3. DNS (para HTTPS automático no Caddy)

No provedor de DNS do seu domínio, crie um registro `A`:

- **Nome**: `atende` (ou subdomínio desejado)
- **Valor**: `<IP_PUBLICO_DA_VPS>`
- **Proxy**: desligado (`DNS only`) se usar Caddy com Let's Encrypt diretamente; ou use **Cloudflare Tunnel** (`-ProxyMode cloudflared`) sem registro A para o IP da VPS.

---

## Como executar a implantação a partir do Windows

1. Prepare um arquivo local com suas variáveis reais (fora do Git, ex.: `C:\Users\jorge\oracle-api.env`), baseado em `infra/oracle/env.oracle.example`:
   - Defina `WHATSAPP_PANEL_ORIGINS=https://atende.seudominio.com`
   - Gere `META_VERIFY_TOKEN` e `META_APP_SECRET` fortes
   - Configure `LLM_PROVIDER=openrouter` e `LLM_API_KEY` (se for usar IA)
   - **Importante**: troque todas as senhas padrão de demonstração (`AtendeLocal123!`) antes de expor o painel publicamente.

2. No PowerShell, na raiz do repositório, execute:

```powershell
# Com Caddy + HTTPS automatico:
.\infra\oracle\deploy-remote.ps1 `
  -VpsHost "<IP_DA_VPS>" `
  -SshUser "ubuntu" `
  -KeyPath "$env:USERPROFILE\.ssh\oracle-vps.key" `
  -Domain "atende.seudominio.com" `
  -EnvFilePath "C:\caminho\privado\api.env"
```

```powershell
# Alternativa com Cloudflare Tunnel (zero portas web abertas):
.\infra\oracle\deploy-remote.ps1 `
  -VpsHost "<IP_DA_VPS>" `
  -SshUser "ubuntu" `
  -KeyPath "$env:USERPROFILE\.ssh\oracle-vps.key" `
  -ProxyMode "cloudflared" `
  -EnvFilePath "C:\caminho\privado\api.env"
```

3. Em atualizações futuras (após o primeiro bootstrap):

```powershell
.\infra\oracle\deploy-remote.ps1 `
  -VpsHost "<IP_DA_VPS>" `
  -SshUser "ubuntu" `
  -KeyPath "$env:USERPROFILE\.ssh\oracle-vps.key" `
  -SkipBootstrap
```

---

## Operação, logs e backup SQLite

Na VPS via SSH (`ssh -i <chave> ubuntu@<IP>`):

```bash
# Status e logs em tempo real
sudo systemctl status atende-api caddy
sudo journalctl -u atende-api -f

# Health checks locais
curl -s http://127.0.0.1:3000/health/live
curl -s http://127.0.0.1:3000/health/ready

# Verificar timer e executar backup manual do SQLite
sudo systemctl list-timers atende-backup.timer
sudo systemctl start atende-backup.service
ls -lh /var/backups/plataforma-atendimento/

# Restaurar um backup (pare a API antes)
sudo systemctl stop atende-api
gunzip -c /var/backups/plataforma-atendimento/attendance-YYYYMMDD-HHMMSS.sqlite.gz \
  | sudo tee /var/lib/plataforma-atendimento/attendance.sqlite >/dev/null
sudo chown atende:atende /var/lib/plataforma-atendimento/attendance.sqlite
sudo chmod 600 /var/lib/plataforma-atendimento/attendance.sqlite
sudo systemctl start atende-api
```
