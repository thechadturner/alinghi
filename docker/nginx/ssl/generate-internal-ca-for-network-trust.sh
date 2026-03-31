#!/usr/bin/env bash
# Create a small internal CA, issue a server cert with SANs for your internal DNS names,
# and write fullchain.pem + privkey.pem for nginx.
#
# TRUST ON THE NETWORK: distribute ONLY ca-cert.pem (public) to clients — install as a
# trusted root (GPO, Intune, or manual). Users then trust any cert signed by this CA.
# Keep ca-key.pem secret on the server (chmod 600); do not email it.
#
# Usage (on the VM):
#   cd .../servers/docker/nginx/ssl
#   sed -i 's/\r$//' generate-internal-ca-for-network-trust.sh
#   bash generate-internal-ca-for-network-trust.sh
# Optional: first arg = VM IP for SAN (e.g. 10.100.30.110) for users who browse by IP.
#
# Requires OpenSSL 1.1.1+ (CSR with -addext). Regenerate: remove fullchain.pem, privkey.pem,
# server.csr, server-cert.pem, ca-*.pem, *.srl and re-run.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Optional arg: extra IP for SAN (e.g. if not 10.100.30.110)
EXTRA_IP="${1:-}"

if [[ -f "$DIR/fullchain.pem" && -f "$DIR/privkey.pem" ]]; then
  echo "fullchain.pem and privkey.pem already exist — remove them (and server-cert.pem / CSR if any) to regenerate."
  exit 0
fi

SAN="DNS:ta-npl-dis-ui01,DNS:ta-npl-dis-ui01.arbr.int,DNS:dis-ui.arbr.int,DNS:localhost,IP:127.0.0.1,IP:10.100.30.110"
if [[ -n "$EXTRA_IP" && "$EXTRA_IP" != "10.100.30.110" ]]; then
  SAN="${SAN},IP:${EXTRA_IP}"
fi

CA_SUBJ="/O=Arbr/CN=RaceSight Internal CA"
SRV_SUBJ="/CN=dis-ui.arbr.int"

if [[ ! -f "$DIR/ca-key.pem" || ! -f "$DIR/ca-cert.pem" ]]; then
  openssl genrsa -out "$DIR/ca-key.pem" 4096
  openssl req -x509 -new -nodes -key "$DIR/ca-key.pem" -sha256 -days 3650 \
    -subj "$CA_SUBJ" -out "$DIR/ca-cert.pem" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  chmod 600 "$DIR/ca-key.pem"
  chmod 644 "$DIR/ca-cert.pem"
  echo "Created CA: $DIR/ca-cert.pem (distribute this file for client trust)"
fi

openssl genrsa -out "$DIR/privkey.pem" 2048
openssl req -new -key "$DIR/privkey.pem" -out "$DIR/server.csr" -subj "$SRV_SUBJ" \
  -addext "subjectAltName=${SAN}" \
  -addext "extendedKeyUsage=serverAuth" \
  -addext "keyUsage=digitalSignature,keyEncipherment"

openssl x509 -req -in "$DIR/server.csr" \
  -CA "$DIR/ca-cert.pem" -CAkey "$DIR/ca-key.pem" -CAcreateserial \
  -out "$DIR/server-cert.pem" -days 825 -sha256 -copy_extensions copy

cat "$DIR/server-cert.pem" "$DIR/ca-cert.pem" > "$DIR/fullchain.pem"
chmod 600 "$DIR/privkey.pem"
chmod 644 "$DIR/fullchain.pem" "$DIR/server-cert.pem"

rm -f "$DIR/server.csr"
echo ""
echo "nginx: $DIR/fullchain.pem + $DIR/privkey.pem"
echo "Give IT/users this file ONLY (public): $DIR/ca-cert.pem"
echo "Restart: docker compose restart nginx"
echo "Client trust: see INTERNAL_SSL.txt (import ca-cert.pem as Trusted Root)."
