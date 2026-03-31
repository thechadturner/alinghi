#!/usr/bin/env bash
# Generate fullchain.pem + privkey.pem in this directory (host path mounted as /etc/nginx/ssl).
# Browsers will still warn unless users trust this single cert (or use the internal-CA script instead).
#
# Run on the VM, e.g.:
#   cd .../servers/docker/nginx/ssl && sed -i 's/\r$//' generate-self-signed.sh && bash generate-self-signed.sh
#
# Optional first arg: extra VM IP for SAN if different from 10.100.30.110 (default SAN includes that IP).

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$DIR/fullchain.pem" && -f "$DIR/privkey.pem" ]]; then
  echo "Certs already present: $DIR/fullchain.pem and privkey.pem — remove them to regenerate."
  exit 0
fi

# Optional arg: extra IP for SAN if not 10.100.30.110 (e.g. secondary NIC)
EXTRA_IP="${1:-}"

# Match nginx server_name (edit IP here if the VM address changes)
SAN="DNS:ta-npl-dis-ui01,DNS:ta-npl-dis-ui01.arbr.int,DNS:dis-ui.arbr.int,DNS:localhost,IP:127.0.0.1,IP:10.100.30.110"
if [[ -n "$EXTRA_IP" && "$EXTRA_IP" != "10.100.30.110" ]]; then
  SAN="${SAN},IP:${EXTRA_IP}"
fi

CN="dis-ui.arbr.int"

openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout "$DIR/privkey.pem" \
  -out "$DIR/fullchain.pem" \
  -subj "/CN=${CN}" \
  -addext "subjectAltName=${SAN}"

chmod 600 "$DIR/privkey.pem"
chmod 644 "$DIR/fullchain.pem"
echo "Wrote $DIR/fullchain.pem and privkey.pem (CN=${CN}). Restart nginx: docker compose restart nginx"
