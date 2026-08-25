#!/usr/bin/env bash
#
# Instala o painel CLM IPTV numa instancia Oracle Cloud (Oracle Linux 8/9 ou Ubuntu 22/24).
# Roda como root, na propria VM, e pode ser executado de novo a vontade (idempotente).
#
#   sudo bash deploy/install.sh                       # com o repo ja clonado
#   PUBLIC_IP=1.2.3.4 sudo bash deploy/install.sh     # forcar um IP ou dominio
#   PORT=80 sudo bash deploy/install.sh
#
set -euo pipefail

REPO="${REPO:-https://github.com/devcarlosluiz/clm_painel_iptv.git}"
APP_DIR="${APP_DIR:-/opt/clm-iptv}"
RUN_USER="${RUN_USER:-clmiptv}"
PORT="${PORT:-8080}"
SERVICE=clm-iptv
NODE_MAJOR=24

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m x  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "rode como root: sudo bash $0"

# roda um comando como o usuario do painel (runuser existe nas imagens da OCI)
as_app() {
  if command -v runuser >/dev/null 2>&1; then runuser -u "$RUN_USER" -- "$@"
  else sudo -u "$RUN_USER" "$@"; fi
}

# ---------------------------------------------------------------- pacotes
if command -v dnf >/dev/null 2>&1; then PKG=dnf
elif command -v apt-get >/dev/null 2>&1; then PKG=apt
else die "distribuicao nao suportada (esperado dnf ou apt)"; fi

log "instalando dependencias basicas ($PKG)"
if [ "$PKG" = dnf ]; then
  dnf install -y git curl tar >/dev/null
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq git curl ca-certificates >/dev/null
fi

# ---------------------------------------------------------------- node
# node:sqlite (usado pelo painel) so funciona sem flag a partir do Node 22.13
node_ok=0
if command -v node >/dev/null 2>&1; then
  maj=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  min=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
  if [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 13 ]; }; then node_ok=1; fi
fi

if [ "$node_ok" -eq 1 ]; then
  log "node ja instalado: $(node -v)"
else
  log "instalando Node.js $NODE_MAJOR (NodeSource)"
  if [ "$PKG" = dnf ]; then
    dnf module reset -y nodejs >/dev/null 2>&1 || true
    dnf module disable -y nodejs >/dev/null 2>&1 || true
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    dnf install -y nodejs >/dev/null
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
  log "node instalado: $(node -v)"
fi

# ---------------------------------------------------------------- usuario e codigo
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "criando usuario de sistema $RUN_USER"
  NOLOGIN=/usr/sbin/nologin; [ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
  useradd --system --home-dir "$APP_DIR" --shell "$NOLOGIN" "$RUN_USER"
fi

if [ -d "$APP_DIR/.git" ]; then
  log "atualizando codigo em $APP_DIR"
  git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" reset --hard --quiet origin/main
else
  log "clonando $REPO em $APP_DIR"
  rm -rf "$APP_DIR"
  git clone --quiet --depth 1 "$REPO" "$APP_DIR"
fi

log "instalando dependencias npm"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error

# ---------------------------------------------------------------- IP publico
detect_ip() {
  local ip=""
  # metadata da propria OCI: fonte da verdade para o IP publico desta instancia
  ip=$(curl -s -m 5 -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/vnics/ 2>/dev/null \
       | grep -o '"publicIp"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "$ip" ]; then echo "$ip"; return; fi
  ip=$(curl -s -m 5 https://api.ipify.org 2>/dev/null || true)
  echo "$ip"
}

PUBLIC_IP="${PUBLIC_IP:-$(detect_ip)}"
[ -n "$PUBLIC_IP" ] || die "nao consegui descobrir o IP publico. Rode com: PUBLIC_IP=seu.ip.aqui sudo bash $0"
log "endereco publico desta instancia: $PUBLIC_IP"

case "$PUBLIC_IP" in
  http://*|https://*) PUBLIC_URL="$PUBLIC_IP" ;;
  *)                  PUBLIC_URL="http://${PUBLIC_IP}:${PORT}" ;;
esac

# ---------------------------------------------------------------- .env
if [ -f "$APP_DIR/.env" ]; then
  log ".env ja existe - ajustando apenas HOST, PORT e PUBLIC_URL"
  sed -i -e "s|^PUBLIC_URL=.*|PUBLIC_URL=${PUBLIC_URL}|" \
         -e "s|^HOST=.*|HOST=0.0.0.0|" \
         -e "s|^PORT=.*|PORT=${PORT}|" "$APP_DIR/.env"
  grep -q '^HOST=' "$APP_DIR/.env" || echo "HOST=0.0.0.0" >> "$APP_DIR/.env"
else
  log "criando .env (JWT_SECRET aleatorio)"
  SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  sed -e "s|^PUBLIC_URL=.*|PUBLIC_URL=${PUBLIC_URL}|" \
      -e "s|^HOST=.*|HOST=0.0.0.0|" \
      -e "s|^PORT=.*|PORT=${PORT}|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" "$APP_DIR/.env.example" > "$APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env"

mkdir -p "$APP_DIR/data"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# ---------------------------------------------------------------- banco + admin
NEW_DB=0
[ -f "$APP_DIR/data/panel.db" ] || NEW_DB=1

log "preparando banco (setup)"
as_app node src/scripts/setup.js | tee /tmp/clm-setup.out

if [ "$NEW_DB" -eq 1 ]; then
  log "importando lista.m3u (pode demorar alguns minutos)"
  as_app node src/scripts/import-m3u.js
  log "criando pacotes e planos com o conteudo importado"
  as_app node src/scripts/setup.js >/dev/null
fi

# ---------------------------------------------------------------- systemd
log "instalando servico systemd ($SERVICE)"
sed -e "s|__RUN_USER__|$RUN_USER|g" -e "s|__APP_DIR__|$APP_DIR|g" \
    "$APP_DIR/deploy/clm-iptv.service" > "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

# ---------------------------------------------------------------- firewall do SO
log "liberando a porta $PORT no firewall do sistema"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null
  firewall-cmd --reload >/dev/null
  echo "   firewalld: porta ${PORT}/tcp liberada"
else
  iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp --dport "$PORT" -j ACCEPT
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null
  elif [ -d /etc/iptables ]; then
    iptables-save > /etc/iptables/rules.v4
  else
    warn "regra iptables aplicada mas NAO persistida (instale iptables-persistent)"
  fi
  echo "   iptables: porta ${PORT}/tcp liberada"
fi

# ---------------------------------------------------------------- verificacao
sleep 2
log "verificando"
if curl -s -m 5 "http://127.0.0.1:${PORT}/healthz" | grep -q '"ok":true'; then
  echo "   healthz  ....: OK"
else
  warn "healthz nao respondeu - veja: journalctl -u $SERVICE -n 50 --no-pager"
fi
echo "   /painel/ ....: HTTP $(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${PORT}/painel/")"

ADMIN_LINE=$(grep -i 'admin criado' /tmp/clm-setup.out 2>/dev/null || true)
if [ -z "$ADMIN_LINE" ]; then
  ADMIN_LINE="admin ja existia. Para trocar a senha: sudo -u $RUN_USER node $APP_DIR/src/scripts/setup.js --user admin --pass NOVASENHA"
fi
rm -f /tmp/clm-setup.out

echo ""
echo "--------------------------------------------------------------------"
echo "  Painel ....: ${PUBLIC_URL}/painel/"
echo "  Acesso ....: ${ADMIN_LINE}"
echo "  Servico ...: systemctl status ${SERVICE}   |   journalctl -u ${SERVICE} -f"
echo ""
echo "  FALTA UM PASSO NO CONSOLE DA ORACLE:"
echo "  libere a porta ${PORT}/tcp de entrada na Security List / NSG da subnet,"
echo "  senao o IP publico continua sem responder de fora."
echo "--------------------------------------------------------------------"
