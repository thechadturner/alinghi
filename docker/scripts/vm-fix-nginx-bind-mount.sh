#!/usr/bin/env bash
# Fix Docker bind-mount error: "Are you trying to mount a directory onto a file?"
# When the host path for a FILE mount does not exist, Docker may create a DIRECTORY
# with that name. The next start then fails. Run this on the VM from VM_BASE_PATH
# (e.g. /home/ta/racesight) before `docker compose up`.
#
# Usage:
#   cd /home/ta/racesight
#   bash servers/docker/scripts/vm-fix-nginx-bind-mount.sh
#
# Afterward, if nginx-prod.conf is still missing, copy the file from the repo:
#   docker/nginx/nginx-prod.conf -> servers/docker/nginx/nginx-prod.conf
# or re-run a full DEPLOY_VM_SERVERS deploy.

set -euo pipefail

BASE="${1:-.}"
CONF="${BASE}/servers/docker/nginx/nginx-prod.conf"

if [[ -d "$CONF" ]]; then
  echo "[vm-fix-nginx] Removing mistaken directory (should be a file): $CONF"
  # Docker may have created this as root; plain rm can fail without sudo — delete via container mount.
  rm -rf "$CONF" 2>/dev/null || docker run --rm -v "$(dirname "$CONF"):/mnt" alpine rm -rf "/mnt/$(basename "$CONF")"
fi

if [[ ! -f "$CONF" ]]; then
  echo "[vm-fix-nginx] ERROR: Missing file: $CONF"
  echo "[vm-fix-nginx] Copy docker/nginx/nginx-prod.conf from the repo to that path, or run a full server deploy."
  exit 1
fi

echo "[vm-fix-nginx] OK: $CONF is a regular file ($(wc -c < "$CONF") bytes)."
