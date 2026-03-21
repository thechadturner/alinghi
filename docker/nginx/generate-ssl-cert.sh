#!/bin/bash
# Generate self-signed SSL certificate for development
# This allows HTTPS access to 192.168.0.18, making it a trustworthy origin for COOP/COEP headers

SSL_DIR="$(dirname "$0")/ssl"
mkdir -p "$SSL_DIR"

# Generate private key
openssl genrsa -out "$SSL_DIR/key.pem" 2048

# Generate certificate (valid for 365 days)
openssl req -new -x509 -key "$SSL_DIR/key.pem" -out "$SSL_DIR/cert.pem" -days 365 \
    -subj "/C=US/ST=State/L=City/O=Development/CN=192.168.0.18" \
    -addext "subjectAltName=IP:192.168.0.18,DNS:192.168.0.18,DNS:localhost,IP:127.0.0.1"

echo "SSL certificates generated in $SSL_DIR/"
echo "Certificate: $SSL_DIR/cert.pem"
echo "Private key: $SSL_DIR/key.pem"
echo ""
echo "To use HTTPS, uncomment the HTTPS server block in nginx-dev.conf"

