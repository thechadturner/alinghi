#!/usr/bin/env bash
# Run on the VM after deploy extracts servers/ (called from DEPLOY_VM_SERVERS.bat).
# Ensures nginx-prod.conf can load fullchain.pem + privkey.pem:
#   1) Already present and non-empty -> no-op
#   2) cert.pem + key.pem present -> copy to expected names
#   3) Else generate self-signed (browser warning until trusted; see ssl/INTERNAL_SSL.txt)
#
# Usage: ensure-nginx-tls-on-vm.sh <ssl_directory_on_host> [extra_ip_for_SAN]
set -u

SSL_DIR="${1:-}"
EXTRA_IP="${2:-}"

if [[ -z "$SSL_DIR" ]]; then
  echo "[ensure-nginx-tls] ERROR: missing argument: ssl directory" >&2
  exit 1
fi

mkdir -p "$SSL_DIR"
cd "$SSL_DIR" || exit 1

have_pair() {
  [[ -f fullchain.pem && -f privkey.pem ]] && [[ -s fullchain.pem && -s privkey.pem ]]
}

if have_pair; then
  echo "[ensure-nginx-tls] OK: fullchain.pem and privkey.pem already present in $SSL_DIR"
  exit 0
fi

if [[ -f cert.pem && -f key.pem ]]; then
  cp -a cert.pem fullchain.pem
  cp -a key.pem privkey.pem
  chmod 644 fullchain.pem
  chmod 600 privkey.pem
  echo "[ensure-nginx-tls] OK: copied cert.pem/key.pem -> fullchain.pem/privkey.pem"
  exit 0
fi

# Match generate-self-signed.sh SAN defaults; add optional VM IP for VPN/LAN access
SAN="DNS:ta-npl-dis-ui01,DNS:ta-npl-dis-ui01.arbr.int,DNS:dis-ui.arbr.int,DNS:localhost,IP:127.0.0.1,IP:10.100.30.110"
if [[ -n "$EXTRA_IP" && "$EXTRA_IP" != "10.100.30.110" ]]; then
  SAN="${SAN},IP:${EXTRA_IP}"
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "[ensure-nginx-tls] ERROR: openssl not installed on VM; install openssl or place fullchain.pem + privkey.pem in $SSL_DIR" >&2
  exit 1
fi

openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout privkey.pem \
  -out fullchain.pem \
  -subj "/CN=dis-ui.arbr.int" \
  -addext "subjectAltName=${SAN}"

chmod 644 fullchain.pem
chmod 600 privkey.pem
echo "[ensure-nginx-tls] Generated self-signed fullchain.pem + privkey.pem in $SSL_DIR"
echo "[ensure-nginx-tls] Browsers will warn until the cert or your internal CA is trusted (see docker/nginx/ssl/INTERNAL_SSL.txt)"
