#!/usr/bin/env bash
# ==============================================================================
# Oracle Cloud Always Free Tier - Bootstrap idempotente (Ubuntu 22.04 / 24.04)
# Arquiteturas suportadas: arm64 (VM.Standard.A1.Flex) e amd64 (VM.Standard.E2.1.Micro)
# Custo alvo: R$ 0/mês (sem Docker, sem OCI Load Balancer, sem DB gerenciado)
# ==============================================================================
set -euo pipefail

APP_USER="atende"
APP_GROUP="atende"
APP_DIR="/opt/plataforma-atendimento"
DATA_DIR="/var/lib/plataforma-atendimento"
BACKUP_DIR="/var/backups/plataforma-atendimento"
CONF_DIR="/etc/plataforma-atendimento"
ENV_FILE="${CONF_DIR}/api.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROXY_MODE="caddy"       # caddy | cloudflared | none
APP_DOMAIN=""
SWAP_MB="2048"
MEMORY_MAX=""            # auto se vazio (700M em VMs <= 1.5GB, 1536M em VMs maiores)
NODE_MAJOR="22"
MIN_NODE_MINOR="13"

usage() {
  cat <<'EOF'
Uso: sudo bash bootstrap-vps.sh [opcoes]

Opcoes:
  --proxy <caddy|cloudflared|none>  Proxy/exposicao web (padrao: caddy)
  --domain <dominio>                Dominio publico para o Caddy (ex.: atende.exemplo.com)
  --swap-mb <MB>                    Tamanho do swapfile em MB (padrao: 2048; 0 desativa)
  --memory-max <valor>              Limite MemoryMax do systemd (ex.: 700M ou 1536M)
  -h, --help                        Mostra esta ajuda
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy)
      PROXY_MODE="${2:-}"
      shift 2
      ;;
    --domain)
      APP_DOMAIN="${2:-}"
      shift 2
      ;;
    --swap-mb)
      SWAP_MB="${2:-}"
      shift 2
      ;;
    --memory-max)
      MEMORY_MAX="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERRO] Parametro desconhecido: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERRO] Execute este script como root (ex.: sudo bash $0)." >&2
  exit 1
fi

case "${PROXY_MODE}" in
  caddy|cloudflared|none) ;;
  *)
    echo "[ERRO] --proxy deve ser caddy, cloudflared ou none (recebido: ${PROXY_MODE})." >&2
    exit 1
    ;;
esac

if ! [[ "${SWAP_MB}" =~ ^[0-9]+$ ]]; then
  echo "[ERRO] --swap-mb deve ser um inteiro >= 0." >&2
  exit 1
fi

log() {
  echo "[atende-bootstrap] $*"
}

# ------------------------------------------------------------------------------
# 1. Validar sistema operacional e arquitetura
# ------------------------------------------------------------------------------
ARCH="$(dpkg --print-architecture)"
case "${ARCH}" in
  arm64|amd64) ;;
  *)
    echo "[ERRO] Arquitetura nao suportada: ${ARCH} (esperado arm64 ou amd64)." >&2
    exit 1
    ;;
esac

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  log "Sistema detectado: ${PRETTY_NAME:-Linux} (${ARCH})"
else
  log "Sistema detectado: Linux (${ARCH})"
fi

TOTAL_MEM_MB="$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
if [[ -z "${MEMORY_MAX}" ]]; then
  if (( TOTAL_MEM_MB <= 1536 )); then
    MEMORY_MAX="700M"
    MEMORY_HIGH="560M"
  else
    MEMORY_MAX="1536M"
    MEMORY_HIGH="1280M"
  fi
else
  MEMORY_HIGH=""
fi
log "RAM detectada: ${TOTAL_MEM_MB} MB | Limite systemd MemoryMax=${MEMORY_MAX}"

# ------------------------------------------------------------------------------
# 2. Swap de 2GB (essencial em VM.Standard.E2.1.Micro 1GB, seguro em A1.Flex)
# ------------------------------------------------------------------------------
setup_swap() {
  if (( SWAP_MB == 0 )); then
    log "Swap desativado (--swap-mb 0)."
    return
  fi

  if swapon --show=NAME --noheadings | grep -qx "/swapfile"; then
    log "Swap /swapfile ja esta ativo."
  else
    if [[ ! -f /swapfile ]]; then
      log "Criando swapfile de ${SWAP_MB} MB em /swapfile..."
      if ! fallocate -l "${SWAP_MB}M" /swapfile 2>/dev/null; then
        dd if=/dev/zero of=/swapfile bs=1M count="${SWAP_MB}" status=none
      fi
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
    else
      chmod 600 /swapfile
    fi
    swapon /swapfile
    log "Swap /swapfile ativado."
  fi

  if ! grep -qE '^/swapfile[[:space:]]' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  cat > /etc/sysctl.d/99-atende-swap.conf <<'EOF'
# Conserva RAM para o processo Node e reduz pressao de swap em VMs Always Free
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
  sysctl --system >/dev/null 2>&1 || sysctl -p /etc/sysctl.d/99-atende-swap.conf >/dev/null
}

setup_swap

# ------------------------------------------------------------------------------
# 3. Pacotes base (sem bloat / sem Docker)
# ------------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
log "Atualizando indices APT e instalando pacotes base..."
apt-get update -qq
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
apt-get install -y -qq \
  apt-transport-https \
  ca-certificates \
  curl \
  debian-archive-keyring \
  debian-keyring \
  git \
  gnupg \
  gzip \
  iptables-persistent \
  lsb-release \
  netfilter-persistent \
  sqlite3 \
  tar \
  ufw \
  unattended-upgrades

# ------------------------------------------------------------------------------
# 4. Node.js 22 LTS (>= 22.13.0) via NodeSource (arm64 e amd64)
# ------------------------------------------------------------------------------
check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local ver major minor
  ver="$(node -v | sed 's/^v//')"
  major="${ver%%.*}"
  minor="$(echo "${ver}" | cut -d. -f2)"
  if (( major > NODE_MAJOR )) || { (( major == NODE_MAJOR )) && (( minor >= MIN_NODE_MINOR )); }; then
    return 0
  fi
  return 1
}

if check_node_version; then
  log "Node.js ja atende ao requisito: $(node -v)"
else
  log "Instalando Node.js ${NODE_MAJOR}.x LTS via NodeSource..."
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  if ! check_node_version; then
    echo "[ERRO] Versao instalada do Node ($(node -v 2>/dev/null || echo ausente)) e inferior a ${NODE_MAJOR}.${MIN_NODE_MINOR}.0." >&2
    exit 1
  fi
  log "Node.js instalado: $(node -v) | npm: $(npm -v)"
fi

# ------------------------------------------------------------------------------
# 5. Reverse proxy gratuito: Caddy (auto-TLS) ou Cloudflare Tunnel (cloudflared)
# ------------------------------------------------------------------------------
install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    log "Caddy ja instalado: $(caddy version)"
    return
  fi
  log "Instalando Caddy (repositorio oficial)..."
  install -d -m 0755 /usr/share/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  log "Caddy instalado: $(caddy version)"
}

install_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    log "cloudflared ja instalado: $(cloudflared --version)"
    return
  fi
  log "Instalando cloudflared (repositorio oficial Cloudflare)..."
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | gpg --dearmor --yes -o /usr/share/keyrings/cloudflare-main.gpg
  local codename
  codename="$(lsb_release -cs 2>/dev/null || echo jammy)"
  # Cloudflare publica pacotes por codename; jammy/noble funcionam com repo focal/jammy fallback
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y -qq cloudflared
  log "cloudflared instalado: $(cloudflared --version) (codename=${codename})"
}

if [[ "${PROXY_MODE}" == "caddy" ]]; then
  install_caddy
elif [[ "${PROXY_MODE}" == "cloudflared" ]]; then
  install_caddy
  install_cloudflared
fi

# ------------------------------------------------------------------------------
# 6. Usuario de sistema sem privilegios e estrutura de diretorios
# ------------------------------------------------------------------------------
if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
  groupadd --system "${APP_GROUP}"
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system \
    --gid "${APP_GROUP}" \
    --home-dir "${DATA_DIR}" \
    --shell /usr/sbin/nologin \
    --comment "Plataforma de Atendimento WhatsApp" \
    "${APP_USER}"
  log "Usuario de sistema '${APP_USER}' criado."
fi

install -d -m 0755 -o "${APP_USER}" -g "${APP_GROUP}" "${APP_DIR}"
install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}"
install -d -m 0700 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}/whatsapp"
install -d -m 0700 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}/whatsapp/sessions"
install -d -m 0700 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}/whatsapp/state"
install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" "${BACKUP_DIR}"
install -d -m 0750 -o root -g "${APP_GROUP}" "${CONF_DIR}"

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${SCRIPT_DIR}/env.oracle.example" ]]; then
    install -m 0640 -o root -g "${APP_GROUP}" "${SCRIPT_DIR}/env.oracle.example" "${ENV_FILE}"
  elif [[ -f "${APP_DIR}/infra/oracle/env.oracle.example" ]]; then
    install -m 0640 -o root -g "${APP_GROUP}" "${APP_DIR}/infra/oracle/env.oracle.example" "${ENV_FILE}"
  else
    cat > "${ENV_FILE}" <<'EOF'
NODE_ENV=production
ENABLE_LOCAL_DEMO=false
API_HOST=127.0.0.1
API_PORT=3000
LOG_LEVEL=info
DATABASE_URL=
LOCAL_SQLITE_PATH=/var/lib/plataforma-atendimento/attendance.sqlite
WHATSAPP_CHANNEL_ENABLED=true
WHATSAPP_PROVIDER=unofficial_qr
WHATSAPP_SESSION_DIR=/var/lib/plataforma-atendimento/whatsapp/sessions
WHATSAPP_STATE_DIR=/var/lib/plataforma-atendimento/whatsapp/state
WHATSAPP_PANEL_ORIGINS=
META_VERIFY_TOKEN=troque-por-token-aleatorio-forte
META_APP_SECRET=troque-por-app-secret-ou-desative-assinatura
META_REQUIRE_SIGNATURE=true
EOF
    chown root:"${APP_GROUP}" "${ENV_FILE}"
    chmod 0640 "${ENV_FILE}"
  fi
  log "Arquivo de ambiente inicial criado em ${ENV_FILE} (edite os segredos antes de iniciar)."
else
  chown root:"${APP_GROUP}" "${ENV_FILE}"
  chmod 0640 "${ENV_FILE}"
  log "Arquivo de ambiente existente preservado em ${ENV_FILE}."
fi

# ------------------------------------------------------------------------------
# 7. Firewall seguro: OCI iptables (netfilter-persistent) + UFW sem travar SSH
# ------------------------------------------------------------------------------
ensure_iptables_rule_before_reject() {
  local proto="$1"
  local port="$2"

  if iptables -C INPUT -p "${proto}" -m state --state NEW -m "${proto}" --dport "${port}" -j ACCEPT 2>/dev/null; then
    return 0
  fi

  local reject_line
  reject_line="$(iptables -L INPUT --line-numbers -n | awk '/REJECT/ { print $1; exit }')"
  if [[ -n "${reject_line}" ]]; then
    iptables -I INPUT "${reject_line}" -p "${proto}" -m state --state NEW -m "${proto}" --dport "${port}" -j ACCEPT
  else
    iptables -A INPUT -p "${proto}" -m state --state NEW -m "${proto}" --dport "${port}" -j ACCEPT
  fi
}

setup_firewall() {
  log "Configurando regras de iptables (imagens Ubuntu da Oracle) e UFW preservando SSH 22..."

  # Garante SSH e conexoes estabelecidas no topo do INPUT
  if ! iptables -C INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -m state --state RELATED,ESTABLISHED -j ACCEPT
  fi
  if ! iptables -C INPUT -i lo -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 1 -i lo -j ACCEPT
  fi
  ensure_iptables_rule_before_reject tcp 22

  if [[ "${PROXY_MODE}" == "caddy" ]]; then
    ensure_iptables_rule_before_reject tcp 80
    ensure_iptables_rule_before_reject tcp 443
    ensure_iptables_rule_before_reject udp 443
  fi

  netfilter-persistent save >/dev/null 2>&1 || true

  # UFW: sempre libera SSH antes de ativar
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  ufw allow 22/tcp comment 'SSH' >/dev/null

  if [[ "${PROXY_MODE}" == "caddy" ]]; then
    ufw allow 80/tcp comment 'HTTP Caddy ACME/Redirect' >/dev/null
    ufw allow 443/tcp comment 'HTTPS Caddy' >/dev/null
    ufw allow 443/udp comment 'HTTP3 QUIC Caddy' >/dev/null
  else
    log "Modo ${PROXY_MODE}: portas 80/443 NAO abertas publicamente no firewall."
  fi

  # Verifica explicitamente se 22/tcp esta listado antes de habilitar o UFW
  if ufw show added | grep -qE '22/tcp'; then
    ufw --force enable >/dev/null
    log "UFW ativo com SSH 22 preservado."
  else
    echo "[ERRO] Regra SSH 22/tcp nao confirmada no UFW; abortando ativacao para evitar bloqueio." >&2
    exit 1
  fi
}

setup_firewall

# ------------------------------------------------------------------------------
# 8. Limites do journald para nao encher o disco no Always Free
# ------------------------------------------------------------------------------
install -d -m 0755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/99-atende-free-tier.conf <<'EOF'
[Journal]
SystemMaxUse=200M
SystemKeepFree=1G
MaxFileSec=7day
MaxRetentionSec=14day
Compress=yes
EOF
systemctl restart systemd-journald || true

# ------------------------------------------------------------------------------
# 9. Unidade systemd da API (hardened + MemoryMax + Restart=on-failure)
# ------------------------------------------------------------------------------
UNIT_SRC=""
if [[ -f "${SCRIPT_DIR}/atende-api.service" ]]; then
  UNIT_SRC="${SCRIPT_DIR}/atende-api.service"
elif [[ -f "${APP_DIR}/infra/oracle/atende-api.service" ]]; then
  UNIT_SRC="${APP_DIR}/infra/oracle/atende-api.service"
fi

if [[ -n "${UNIT_SRC}" ]]; then
  install -m 0644 "${UNIT_SRC}" /etc/systemd/system/atende-api.service
else
  cat > /etc/systemd/system/atende-api.service <<'EOF'
[Unit]
Description=Plataforma de Atendimento WhatsApp API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=atende
Group=atende
WorkingDirectory=/opt/plataforma-atendimento/apps/api
EnvironmentFile=/etc/plataforma-atendimento/api.env
ExecStart=/usr/bin/node /opt/plataforma-atendimento/apps/api/dist/server.js
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=5
TimeoutStopSec=25
KillSignal=SIGTERM
MemoryMax=768M
TasksMax=128
LimitNOFILE=16384
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077
ReadWritePaths=/var/lib/plataforma-atendimento
StandardOutput=journal
StandardError=journal
SyslogIdentifier=atende-api

[Install]
WantedBy=multi-user.target
EOF
fi

# Drop-in dinamico de MemoryMax ajustado a RAM real da instancia (E2.1.Micro vs A1.Flex)
install -d -m 0755 /etc/systemd/system/atende-api.service.d
{
  echo "[Service]"
  echo "MemoryMax=${MEMORY_MAX}"
  if [[ -n "${MEMORY_HIGH}" ]]; then
    echo "MemoryHigh=${MEMORY_HIGH}"
  fi
} > /etc/systemd/system/atende-api.service.d/10-memory.conf

# ------------------------------------------------------------------------------
# 10. Configuracao do Caddy (quando PROXY_MODE=caddy ou cloudflared)
# ------------------------------------------------------------------------------
if [[ "${PROXY_MODE}" == "caddy" || "${PROXY_MODE}" == "cloudflared" ]]; then
  CADDY_SRC=""
  if [[ -f "${SCRIPT_DIR}/Caddyfile.oracle" ]]; then
    CADDY_SRC="${SCRIPT_DIR}/Caddyfile.oracle"
  elif [[ -f "${APP_DIR}/infra/oracle/Caddyfile.oracle" ]]; then
    CADDY_SRC="${APP_DIR}/infra/oracle/Caddyfile.oracle"
  fi

  install -d -m 0755 /etc/caddy
  if [[ -n "${CADDY_SRC}" ]]; then
    if [[ -f /etc/caddy/Caddyfile ]] && ! cmp -s "${CADDY_SRC}" /etc/caddy/Caddyfile; then
      cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
    fi
    install -m 0644 "${CADDY_SRC}" /etc/caddy/Caddyfile
  fi

  # Define APP_DOMAIN para o Caddy via EnvironmentFile dedicado
  if [[ -n "${APP_DOMAIN}" ]]; then
    echo "APP_DOMAIN=${APP_DOMAIN}" > /etc/caddy/caddy.env
  elif [[ ! -f /etc/caddy/caddy.env ]]; then
    if [[ "${PROXY_MODE}" == "cloudflared" ]]; then
      echo "APP_DOMAIN=http://127.0.0.1:8080" > /etc/caddy/caddy.env
    else
      echo "APP_DOMAIN=:80" > /etc/caddy/caddy.env
    fi
  fi
  chmod 0644 /etc/caddy/caddy.env

  install -d -m 0755 /etc/systemd/system/caddy.service.d
  cat > /etc/systemd/system/caddy.service.d/10-atende-env.conf <<'EOF'
[Service]
EnvironmentFile=-/etc/caddy/caddy.env
EOF
fi

# ------------------------------------------------------------------------------
# 11. Backup diario comprimido do SQLite com retencao de 7 dias (systemd timer)
# ------------------------------------------------------------------------------
cat > /usr/local/bin/atende-sqlite-backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DB_PATH="/var/lib/plataforma-atendimento/attendance.sqlite"
BACKUP_DIR="/var/backups/plataforma-atendimento"
RETENTION_DAYS=7

if [[ -f /etc/plataforma-atendimento/api.env ]]; then
  env_db="$(grep -E '^LOCAL_SQLITE_PATH=' /etc/plataforma-atendimento/api.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  if [[ -n "${env_db}" ]]; then
    DB_PATH="${env_db}"
  fi
fi

if [[ ! -f "${DB_PATH}" ]]; then
  echo "[atende-backup] Banco SQLite ainda nao existe em ${DB_PATH}; ignorando."
  exit 0
fi

mkdir -p "${BACKUP_DIR}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TMP_SQLITE="$(mktemp "${BACKUP_DIR}/.attendance-${STAMP}.XXXXXX.sqlite")"
FINAL_GZ="${BACKUP_DIR}/attendance-${STAMP}.sqlite.gz"

cleanup() {
  rm -f "${TMP_SQLITE}"
}
trap cleanup EXIT

# .backup usa a API online do SQLite (consistente mesmo em modo WAL com API rodando)
sqlite3 "${DB_PATH}" ".timeout 10000" ".backup '${TMP_SQLITE}'"
gzip -9 -c "${TMP_SQLITE}" > "${FINAL_GZ}"
chmod 0600 "${FINAL_GZ}"
gzip -t "${FINAL_GZ}"

# Retencao de 7 dias
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'attendance-*.sqlite.gz' -mtime "+${RETENTION_DAYS}" -delete
echo "[atende-backup] Backup concluido: ${FINAL_GZ}"
EOF
chmod 0755 /usr/local/bin/atende-sqlite-backup.sh

cat > /etc/systemd/system/atende-backup.service <<'EOF'
[Unit]
Description=Backup diario comprimido do SQLite da Plataforma de Atendimento

[Service]
Type=oneshot
User=atende
Group=atende
ExecStart=/usr/local/bin/atende-sqlite-backup.sh
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/plataforma-atendimento /var/lib/plataforma-atendimento
ReadWritePaths=/var/backups/plataforma-atendimento
EOF

cat > /etc/systemd/system/atende-backup.timer <<'EOF'
[Unit]
Description=Agendamento diario do backup SQLite (retencao 7 dias)

[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF

# ------------------------------------------------------------------------------
# 12. Recarregar systemd e habilitar timers/servicos
# ------------------------------------------------------------------------------
systemctl daemon-reload
systemctl enable atende-backup.timer >/dev/null
systemctl start atende-backup.timer

if [[ "${PROXY_MODE}" == "caddy" || "${PROXY_MODE}" == "cloudflared" ]]; then
  systemctl enable caddy >/dev/null
fi

log "Bootstrap concluido com sucesso!"
log "Resumo:"
log "  - Node.js:   $(node -v)"
log "  - Usuario:   ${APP_USER}"
log "  - App dir:   ${APP_DIR}"
log "  - Dados:     ${DATA_DIR}"
log "  - Env file:  ${ENV_FILE}"
log "  - Backups:   ${BACKUP_DIR} (timer diario, retencao 7 dias)"
log "  - Proxy:     ${PROXY_MODE} (dominio: ${APP_DOMAIN:-nao definido})"
log "Proximo passo: revisar ${ENV_FILE}, gerar builds em ${APP_DIR} e executar 'systemctl enable --now atende-api caddy'."
