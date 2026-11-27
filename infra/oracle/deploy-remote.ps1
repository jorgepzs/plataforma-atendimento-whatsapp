<#
.SYNOPSIS
    Sincroniza o repositorio e implanta a Plataforma de Atendimento WhatsApp
    em uma VPS Ubuntu no Oracle Cloud Always Free Tier via SSH/SCP nativo do Windows.

.DESCRIPTION
    - Empacota o repositorio local com tar.exe (excluindo node_modules, .git, .data, .env e artefatos locais).
    - Envia o pacote para a VPS via scp.exe e extrai em /opt/plataforma-atendimento.
    - Executa infra/oracle/bootstrap-vps.sh (idempotente) para swap, Node 22, Caddy/cloudflared, firewall, systemd e backup SQLite.
    - Instala dependencias e executa build de API + Web como usuario sem privilegios 'atende'.
    - Configura /etc/plataforma-atendimento/api.env com seguranca (sem sobrescrever arquivo existente sem -EnvFilePath).
    - Reinicia servicos systemd e valida os endpoints locais /health/live e /health/ready.

.EXAMPLE
    .\infra\oracle\deploy-remote.ps1 -VpsHost 129.148.x.x -SshUser ubuntu -KeyPath "$env:USERPROFILE\.ssh\oracle-vps.key" -Domain "atende.seudominio.com"

.EXAMPLE
    # Redeploy rapido de codigo (pula bootstrap do SO):
    .\infra\oracle\deploy-remote.ps1 -VpsHost 129.148.x.x -SshUser ubuntu -KeyPath "$env:USERPROFILE\.ssh\oracle-vps.key" -SkipBootstrap
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VpsHost,

    [string]$SshUser = "ubuntu",

    [Parameter(Mandatory = $true)]
    [string]$KeyPath,

    [int]$SshPort = 22,

    [string]$Domain = "",

    [ValidateSet("caddy", "cloudflared", "none")]
    [string]$ProxyMode = "caddy",

    [int]$SwapMb = 2048,

    [string]$EnvFilePath = "",

    [switch]$SkipBootstrap,

    [switch]$SkipStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-Tool([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Ferramenta obrigatoria nao encontrada no PATH: $Name"
    }
}

# 1. Validacoes locais
Write-Step "Validando pre-requisitos locais (ssh, scp, tar e chave privada)"
Assert-Tool "ssh"
Assert-Tool "scp"
Assert-Tool "tar"

$ResolvedKeyPath = (Resolve-Path -LiteralPath $KeyPath -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $ResolvedKeyPath -PathType Leaf)) {
    throw "Chave SSH nao encontrada: $KeyPath"
}

$ResolvedEnvPath = ""
if ($EnvFilePath) {
    $ResolvedEnvPath = (Resolve-Path -LiteralPath $EnvFilePath -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $ResolvedEnvPath -PathType Leaf)) {
        throw "Arquivo de ambiente nao encontrado: $EnvFilePath"
    }
}

if ($Domain -and ($Domain -notmatch '^[A-Za-z0-9._:/-]+$')) {
    throw "Formato de -Domain invalido: $Domain"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Target = "$SshUser@$VpsHost"

$SshCommonArgs = @(
    "-i", $ResolvedKeyPath,
    "-p", "$SshPort",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=6",
    "-o", "ConnectTimeout=15"
)

$ScpCommonArgs = @(
    "-i", $ResolvedKeyPath,
    "-P", "$SshPort",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15"
)

function Invoke-RemoteBash([string]$ScriptContent) {
    # Normaliza para LF para evitar problemas com CRLF no bash remoto
    $LfScript = $ScriptContent -replace "`r`n", "`n"
    $Bytes = [System.Text.Encoding]::UTF8.GetBytes($LfScript)
    $B64 = [Convert]::ToBase64String($Bytes)
    $RemoteCmd = "printf '%s' '$B64' | base64 -d | sudo bash -s"
    & ssh @SshCommonArgs $Target $RemoteCmd
    if ($LASTEXITCODE -ne 0) {
        throw "Comando remoto falhou com codigo de saida $LASTEXITCODE."
    }
}

# 2. Teste rapido de conectividade SSH
Write-Step "Testando conexao SSH com $Target (porta $SshPort)"
& ssh @SshCommonArgs $Target 'echo "SSH OK:" $(hostname) $(uname -m)'
if ($LASTEXITCODE -ne 0) {
    throw "Nao foi possivel conectar via SSH em $Target. Verifique IP, usuario, chave privada (permissoes) e Security List da OCI."
}

# 3. Empacotar repositorio limpo
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LocalArchive = Join-Path $env:TEMP "plataforma-atendimento-$Stamp.tar.gz"
$RemoteArchive = "/tmp/plataforma-atendimento-$Stamp.tar.gz"

try {
    Write-Step "Empacotando codigo-fonte em $LocalArchive (excluindo segredos e builds locais)"
    $TarArgs = @(
        "-czf", $LocalArchive,
        "-C", $RepoRoot,
        "--exclude=.git",
        "--exclude=node_modules",
        "--exclude=apps/api/node_modules",
        "--exclude=apps/web/node_modules",
        "--exclude=apps/api/dist",
        "--exclude=apps/web/dist",
        "--exclude=.data",
        "--exclude=apps/api/.data",
        "--exclude=work",
        "--exclude=coverage",
        "--exclude=.env",
        "--exclude=.env.bak-*",
        "--exclude=.env.meta.local",
        "--exclude=.env.webhook.local",
        "--exclude=.cloudflare-tunnel-local-managed.local",
        "--exclude=*.sqlite",
        "--exclude=*.sqlite-wal",
        "--exclude=*.sqlite-shm",
        "--exclude=*.sqlite.writer.lock",
        "--exclude=*.log",
        "."
    )
    & tar @TarArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao criar arquivo tar.gz."
    }

    $ArchiveSizeMb = [Math]::Round((Get-Item $LocalArchive).Length / 1MB, 2)
    Write-Host "Pacote gerado: $ArchiveSizeMb MB"

    # 4. Enviar pacote para a VPS
    Write-Step "Enviando pacote para $Target`:$RemoteArchive"
    & scp @ScpCommonArgs $LocalArchive "$Target`:$RemoteArchive"
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao enviar pacote via SCP."
    }

    # 5. Enviar arquivo .env opcional (com upload temporario 0600)
    $RemoteEnvTmp = ""
    if ($ResolvedEnvPath) {
        $RemoteEnvTmp = "/tmp/atende-api-$Stamp.env"
        Write-Step "Enviando arquivo de ambiente ($ResolvedEnvPath) para instalacao segura"
        & scp @ScpCommonArgs $ResolvedEnvPath "$Target`:$RemoteEnvTmp"
        if ($LASTEXITCODE -ne 0) {
            throw "Falha ao enviar arquivo .env via SCP."
        }
    }

    # 6. Extrair codigo e executar bootstrap
    Write-Step "Extraindo codigo em /opt/plataforma-atendimento e preparando ambiente Linux"
    $BootstrapFlag = if ($SkipBootstrap) { "1" } else { "0" }
    $SkipStartFlag = if ($SkipStart) { "1" } else { "0" }

    $RemoteHeader = @"
set -euo pipefail
ARCHIVE="$RemoteArchive"
ENV_TMP="$RemoteEnvTmp"
APP_DIR="/opt/plataforma-atendimento"
CONF_DIR="/etc/plataforma-atendimento"
ENV_FILE="`${CONF_DIR}/api.env"
SKIP_BOOTSTRAP="$BootstrapFlag"
SKIP_START="$SkipStartFlag"
PROXY_MODE="$ProxyMode"
APP_DOMAIN="$Domain"
SWAP_MB="$SwapMb"
"@

    $RemoteBody = @'
cleanup() {
  rm -f "${ARCHIVE}"
  if [[ -n "${ENV_TMP}" ]]; then
    rm -f "${ENV_TMP}"
  fi
}
trap cleanup EXIT

mkdir -p "${APP_DIR}"
# Extrai preservando estrutura limpa sem remover eventuais arquivos extras fora do codigo
tar -xzf "${ARCHIVE}" -C "${APP_DIR}"

# Garante terminacoes LF nos scripts de infra
if [[ -d "${APP_DIR}/infra/oracle" ]]; then
  sed -i 's/\r$//' "${APP_DIR}/infra/oracle/"*.sh "${APP_DIR}/infra/oracle/"*.service "${APP_DIR}/infra/oracle/Caddyfile.oracle" "${APP_DIR}/infra/oracle/env.oracle.example" 2>/dev/null || true
  chmod +x "${APP_DIR}/infra/oracle/bootstrap-vps.sh"
fi

if [[ "${SKIP_BOOTSTRAP}" != "1" ]]; then
  BOOTSTRAP_ARGS=(--proxy "${PROXY_MODE}" --swap-mb "${SWAP_MB}")
  if [[ -n "${APP_DOMAIN}" ]]; then
    BOOTSTRAP_ARGS+=(--domain "${APP_DOMAIN}")
  fi
  bash "${APP_DIR}/infra/oracle/bootstrap-vps.sh" "${BOOTSTRAP_ARGS[@]}"
else
  echo "[deploy] Pulando bootstrap (-SkipBootstrap)."
  if [[ -n "${APP_DOMAIN}" && ( "${PROXY_MODE}" == "caddy" || "${PROXY_MODE}" == "cloudflared" ) ]]; then
    echo "APP_DOMAIN=${APP_DOMAIN}" > /etc/caddy/caddy.env
  fi
fi

# Instala arquivo .env se fornecido explicitamente
if [[ -n "${ENV_TMP}" && -f "${ENV_TMP}" ]]; then
  sed -i 's/\r$//' "${ENV_TMP}"
  install -d -m 0750 -o root -g atende "${CONF_DIR}"
  install -m 0640 -o root -g atende "${ENV_TMP}" "${ENV_FILE}"
  echo "[deploy] ${ENV_FILE} atualizado com permissoes 0640 (root:atende)."
fi

# Se dominio foi informado e WHATSAPP_PANEL_ORIGINS ainda esta vazio, preenche automaticamente
if [[ -n "${APP_DOMAIN}" && -f "${ENV_FILE}" ]]; then
  if grep -qE '^WHATSAPP_PANEL_ORIGINS=$' "${ENV_FILE}"; then
    ORIGIN_URL="${APP_DOMAIN}"
    if [[ "${ORIGIN_URL}" != http://* && "${ORIGIN_URL}" != https://* ]]; then
      ORIGIN_URL="https://${ORIGIN_URL}"
    fi
    sed -i "s|^WHATSAPP_PANEL_ORIGINS=$|WHATSAPP_PANEL_ORIGINS=${ORIGIN_URL}|" "${ENV_FILE}"
    echo "[deploy] WHATSAPP_PANEL_ORIGINS definido para ${ORIGIN_URL}"
  fi
fi

chown -R atende:atende "${APP_DIR}"

# Calcula limite de heap para build seguro em VMs de 1 GB RAM (E2.1.Micro)
TOTAL_MEM_MB="$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
BUILD_NODE_OPTS=""
if (( TOTAL_MEM_MB <= 1536 )); then
  BUILD_NODE_OPTS="--max-old-space-size=1024"
fi

echo "[deploy] Instalando dependencias e gerando build da API (apps/api)..."
su -s /bin/bash atende -c "cd '${APP_DIR}/apps/api' && NODE_OPTIONS='${BUILD_NODE_OPTS}' npm ci --no-audit --no-fund && NODE_OPTIONS='${BUILD_NODE_OPTS}' npm run build && npm prune --omit=dev"

echo "[deploy] Instalando dependencias e gerando build do painel Web (apps/web)..."
su -s /bin/bash atende -c "cd '${APP_DIR}/apps/web' && NODE_OPTIONS='${BUILD_NODE_OPTS}' npm ci --no-audit --no-fund && NODE_OPTIONS='${BUILD_NODE_OPTS}' npm run build"

if [[ "${SKIP_START}" == "1" ]]; then
  echo "[deploy] -SkipStart informado: servicos nao foram reiniciados."
  exit 0
fi

# Verifica se ha placeholders nao editados no api.env antes de subir
if grep -qE 'troque-por-' "${ENV_FILE}" 2>/dev/null; then
  echo "[AVISO] ${ENV_FILE} ainda contem valores placeholder ('troque-por-...')."
  echo "[AVISO] Edite ${ENV_FILE} na VPS (sudo nano ${ENV_FILE}) e depois execute:"
  echo "        sudo systemctl enable --now atende-api caddy"
  exit 0
fi

echo "[deploy] Reiniciando servicos systemd..."
systemctl daemon-reload
systemctl enable atende-api >/dev/null
systemctl restart atende-api

if [[ "${PROXY_MODE}" == "caddy" || "${PROXY_MODE}" == "cloudflared" ]]; then
  caddy validate --config /etc/caddy/Caddyfile
  systemctl enable caddy >/dev/null
  systemctl restart caddy
fi

# Aguarda health check local da API
echo "[deploy] Verificando health checks locais em 127.0.0.1:3000..."
READY=0
for i in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:3000/health/live >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "${READY}" -ne 1 ]]; then
  echo "[ERRO] API nao respondeu em http://127.0.0.1:3000/health/live. Ultimos logs:" >&2
  journalctl -u atende-api -n 40 --no-pager >&2 || true
  exit 1
fi

echo "[deploy] /health/live:  $(curl -fsS http://127.0.0.1:3000/health/live)"
echo "[deploy] /health/ready: $(curl -fsS http://127.0.0.1:3000/health/ready || echo 'not_ready')"
systemctl --no-pager --lines=0 status atende-api
'@

    $RemoteDeployScript = "$RemoteHeader`n$RemoteBody"

    Invoke-RemoteBash -ScriptContent $RemoteDeployScript
    Write-Step "Implantacao concluida!"
}
finally {
    if (Test-Path -LiteralPath $LocalArchive) {
        Remove-Item -LiteralPath $LocalArchive -Force -ErrorAction SilentlyContinue
    }
}
