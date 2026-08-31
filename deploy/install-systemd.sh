#!/usr/bin/env bash
# Install TenkiZu as a systemd service (Amazon Lightsail / Ubuntu).
# Usage, from the repo root (512 Mo RAM : d’abord sudo ./deploy/setup-swap.sh) :
#   npm ci --no-audit --no-fund && npm run build:vps
#   sudo ./deploy/install-systemd.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="tenkizu"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Relance avec sudo : sudo $0" >&2
  exit 1
fi

NODE="$(command -v node || true)"
NPM="$(command -v npm || true)"
if [[ -z "$NODE" || -z "$NPM" ]]; then
  echo "node/npm introuvables dans PATH. Installe Node 20+ (nodesource) puis réessaie." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "package.json introuvable dans $APP_DIR" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/.next" ]]; then
  echo "Pas de build. En tant qu’utilisateur normal : cd $APP_DIR && npm ci && npm run build" >&2
  exit 1
fi

# The user who owns the files should run the service (not root).
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  RUN_USER="$SUDO_USER"
else
  RUN_USER="$(stat -c '%U' "$APP_DIR" 2>/dev/null || echo ubuntu)"
fi

NODE_DIR="$(dirname "$NODE")"
PATH_VALUE="${NODE_DIR}:/usr/local/bin:/usr/bin:/bin"

cat > "$UNIT_DST" <<EOF
[Unit]
Description=TenkiZu (Polymarket highest-temperature dashboard)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PATH=${PATH_VALUE}
ExecStart=${NPM} start
Restart=always
RestartSec=4
TimeoutStartSec=60

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" || true

echo
echo "TenkiZu tourne en arrière-plan (port 3014)."
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
echo "Ouvre le port 3014 (ou 80/443 via nginx) dans le firewall Lightsail."
