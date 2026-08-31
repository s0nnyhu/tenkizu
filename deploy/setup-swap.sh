#!/usr/bin/env bash
# 2 GiB swap — Lightsail 512 Mo tue npm ci / next build (OOM killer → "Killed").
#   sudo ./deploy/setup-swap.sh
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Relance avec sudo : sudo $0" >&2
  exit 1
fi

SWAPFILE="${SWAPFILE:-/swapfile}"
SIZE="${SWAP_SIZE:-2G}"

if swapon --show | grep -q .; then
  echo "Swap déjà actif :"
  swapon --show
  free -h
  exit 0
fi

if [[ -f "$SWAPFILE" ]]; then
  echo "$SWAPFILE existe déjà — activation."
else
  if command -v fallocate >/dev/null 2>&1; then
    fallocate -l "$SIZE" "$SWAPFILE"
  else
    dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=progress
  fi
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
fi

swapon "$SWAPFILE"

if ! grep -q "^$SWAPFILE " /etc/fstab 2>/dev/null; then
  echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
fi

echo
free -h
echo "Swap OK. Relance : npm ci && npm run build"
