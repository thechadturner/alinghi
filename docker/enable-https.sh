#!/bin/bash
# Script to enable HTTPS redirect after SSL certificates are obtained
# Run this on the VM after certificates are in place

set -e

NGINX_CONF="/home/racesight/hunico/servers/docker/nginx/nginx-prod.conf"

echo "============================================"
echo "  Enabling HTTPS Redirect"
echo "============================================"
echo

# Check if nginx config exists
if [ ! -f "$NGINX_CONF" ]; then
    echo "[ERROR] Nginx config not found: $NGINX_CONF"
    exit 1
fi

# Check if certificates exist
SSL_DIR="/home/racesight/hunico/servers/docker/nginx/ssl"
if [ ! -f "$SSL_DIR/fullchain.pem" ] || [ ! -f "$SSL_DIR/privkey.pem" ]; then
    echo "[ERROR] SSL certificates not found in $SSL_DIR"
    echo "[INFO] Please obtain certificates first (see docs/distribution/https-ssl-setup.md)"
    exit 1
fi

echo "[INFO] SSL certificates found"
echo

# Enable HTTPS redirect by uncommenting the return statement
echo "[INFO] Enabling HTTPS redirect in nginx configuration..."
sed -i 's/# return 301 https:\/\/\$host\$request_uri;/return 301 https:\/\/$host$request_uri;/' "$NGINX_CONF"

if [ $? -eq 0 ]; then
    echo "[SUCCESS] HTTPS redirect enabled"
else
    echo "[ERROR] Failed to enable HTTPS redirect"
    exit 1
fi

# Comment out HTTP location blocks (they're duplicated in HTTPS block)
echo "[INFO] Commenting out HTTP-only location blocks..."
sed -i 's/^    location \//    # location \//' "$NGINX_CONF"
sed -i 's/^    location \/api\//    # location \/api\//' "$NGINX_CONF"

echo "[SUCCESS] HTTP-only blocks commented out"
echo

# Restart nginx
echo "[INFO] Restarting nginx..."
cd /home/racesight/hunico
docker-compose -f docker-compose.yml restart nginx

if [ $? -eq 0 ]; then
    echo "[SUCCESS] Nginx restarted"
else
    echo "[ERROR] Failed to restart nginx"
    exit 1
fi

echo
echo "============================================"
echo "  HTTPS Redirect Enabled"
echo "============================================"
echo
echo "[INFO] All HTTP traffic will now redirect to HTTPS"
echo "[INFO] Test with: curl -I http://racesight.cloud"
echo "[INFO] Should return: HTTP/1.1 301 Moved Permanently"
echo

