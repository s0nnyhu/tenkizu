#!/usr/bin/env bash
# Installe le collecteur CSV comme service systemd (Amazon Lightsail / Ubuntu).
# Usage, depuis la racine du repo :
#   sudo ./deploy/install-wx-archive.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$APP_DIR/scripts/wx-archive/collect.py"
DATA_DIR="${WX_ARCHIVE_DIR:-$APP_DIR/scripts/wx-archive/data}"
SERVICE_NAME="wx-archive"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Relance avec sudo : sudo $0" >&2
  exit 1
fi

PYTHON="$(command -v python3 || true)"
if [[ -z "$PYTHON" ]]; then
  echo "python3 introuvable dans PATH." >&2
  exit 1
fi

if [[ ! -f "$SCRIPT" ]]; then
  echo "Script introuvable : $SCRIPT" >&2
  exit 1
fi

if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  RUN_USER="$SUDO_USER"
else
  RUN_USER="$(stat -c '%U' "$APP_DIR" 2>/dev/null || echo ubuntu)"
fi

install -d -o "$RUN_USER" -g "$RUN_USER" -m 0755 "$DATA_DIR"
chmod +x "$SCRIPT"

cat > "$UNIT_DST" <<EOF
[Unit]
Description=TenkiZu weather archive (METAR / NWP / PWS / Polymarket → CSV)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}/scripts/wx-archive
Environment=PYTHONUNBUFFERED=1
ExecStart=${PYTHON} ${SCRIPT} --out-dir ${DATA_DIR} --interval 1800 --stations LFPB,LIMC,EHAM
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" || true

echo
echo "Collecteur lancé (cycle immédiat, puis toutes les 30 min)."
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
echo "CSV : ${DATA_DIR}/LFPB.csv  LIMC.csv  EHAM.csv"
