#!/usr/bin/env bash
#
# Instala el panel en un servidor Debian/Ubuntu (VPS o Raspberry Pi)
# y lo deja arrancado como servicio, para que sobreviva a reinicios.
#
#   curl -fsSL https://raw.githubusercontent.com/LordPanZ/Automatizar-WhatsApp-/main/deploy/setup.sh | sudo bash
#
# o, si ya has clonado el repo:  sudo bash deploy/setup.sh
#
set -euo pipefail

REPO="${REPO:-https://github.com/LordPanZ/Automatizar-WhatsApp-.git}"
BRANCH="${BRANCH:-main}"
DEST="${DEST:-/opt/borradores}"
SERVICE_USER="${SERVICE_USER:-borradores}"
NODE_MAJOR=22

if [[ $EUID -ne 0 ]]; then
  echo "Ejecuta esto con sudo." >&2
  exit 1
fi

echo "==> Paquetes base"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git python3 build-essential

# better-sqlite3 se compila si no hay binario precompilado para la arquitectura,
# de ahí build-essential y python3 arriba.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  echo "==> Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v)"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> Usuario de servicio: $SERVICE_USER"
  useradd --system --create-home --home-dir "/home/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

if [[ -d "$DEST/.git" ]]; then
  echo "==> Actualizando $DEST"
  git -C "$DEST" fetch --quiet origin "$BRANCH"
  git -C "$DEST" reset --hard --quiet "origin/$BRANCH"
else
  echo "==> Clonando en $DEST"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DEST"
fi

echo "==> Dependencias"
cd "$DEST"
npm ci --omit=dev --silent

mkdir -p "$DEST/data" "$DEST/auth" "$DEST/config"

if [[ ! -f "$DEST/.env" ]]; then
  echo "==> Creando .env"
  cp "$DEST/.env.example" "$DEST/.env"
  # Un token decente de fábrica, mejor que dejar el de ejemplo.
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  sed -i "s|^PANEL_TOKEN=.*|PANEL_TOKEN=${TOKEN}|" "$DEST/.env"
  GENERATED_TOKEN="$TOKEN"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$DEST"
chmod 600 "$DEST/.env"

echo "==> Servicio systemd"
cp "$DEST/deploy/borradores.service" /etc/systemd/system/borradores.service
systemctl daemon-reload
systemctl enable --quiet borradores

cat <<EOF

────────────────────────────────────────────────────────────
Instalado en $DEST

Falta un paso a mano: edita el fichero de configuración
    sudo nano $DEST/.env

y rellena:
    ANTHROPIC_API_KEY   tu clave de console.anthropic.com
    PAIRING_PHONE       tu número con prefijo, sin + (ej. 34600111222)
EOF

if [[ -n "${GENERATED_TOKEN:-}" ]]; then
  echo "    PANEL_TOKEN         ya generado: ${GENERATED_TOKEN}"
fi

cat <<EOF

Después arranca y mira el código de vinculación de WhatsApp:
    sudo systemctl start borradores
    journalctl -u borradores -f

Para llegar al panel desde el móvil sin abrir puertos al mundo,
instala Tailscale aquí y en el teléfono:
    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up
    sudo tailscale serve --bg 3000

Eso te da una URL https:// privada, que además permite instalar
el panel como app a pantalla completa en Android.
────────────────────────────────────────────────────────────
EOF
