#!/bin/bash

# Script to obtain SSL certificates for racesight.cloud using Certbot standalone mode
# This script handles the initial certificate generation when nginx is running in Docker

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="racesight.cloud"
WWW_DOMAIN="www.racesight.cloud"
EMAIL="${CERTBOT_EMAIL:-}"  # Set CERTBOT_EMAIL environment variable or provide via prompt
SSL_DIR="$(dirname "$0")/../ssl"
COMPOSE_DIR="$(dirname "$0")/../../compose"

echo -e "${GREEN}SSL Certificate Generation Script${NC}"
echo "=========================================="
echo ""

# Check if running as root (required for Certbot)
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Error: This script must be run as root (use sudo)${NC}"
    exit 1
fi

# Check if email is provided
if [ -z "$EMAIL" ]; then
    echo -e "${YELLOW}Email address is required for Let's Encrypt registration${NC}"
    read -p "Enter your email address: " EMAIL
    if [ -z "$EMAIL" ]; then
        echo -e "${RED}Error: Email address is required${NC}"
        exit 1
    fi
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker is not running${NC}"
    exit 1
fi

# Check if nginx container exists
if ! docker ps -a --format '{{.Names}}' | grep -q "^nginx$"; then
    echo -e "${YELLOW}Warning: nginx container not found. Continuing anyway...${NC}"
else
    echo "Stopping nginx container (required for Certbot standalone mode)..."
    cd "$COMPOSE_DIR"
    docker compose -f nginx.yml stop nginx || true
    echo -e "${GREEN}Nginx container stopped${NC}"
fi

# Wait a moment for port 80 to be released
sleep 2

# Check if port 80 is available
if lsof -Pi :80 -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo -e "${RED}Error: Port 80 is still in use. Please stop any service using port 80${NC}"
    exit 1
fi

# Create SSL directory if it doesn't exist
mkdir -p "$SSL_DIR"

echo ""
echo "Obtaining SSL certificates from Let's Encrypt..."
echo "Domain: $DOMAIN"
echo "Domain: $WWW_DOMAIN"
echo ""

# Obtain certificates using Certbot standalone mode
certbot certonly --standalone \
    -d "$DOMAIN" \
    -d "$WWW_DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --non-interactive \
    --preferred-challenges http

if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to obtain SSL certificates${NC}"
    echo "Starting nginx container..."
    cd "$COMPOSE_DIR"
    docker compose -f nginx.yml start nginx || true
    exit 1
fi

echo ""
echo -e "${GREEN}Certificates obtained successfully!${NC}"
echo ""

# Copy certificates to Docker nginx SSL directory
CERT_SOURCE="/etc/letsencrypt/live/$DOMAIN"
echo "Copying certificates to Docker nginx SSL directory..."

if [ ! -f "$CERT_SOURCE/fullchain.pem" ] || [ ! -f "$CERT_SOURCE/privkey.pem" ]; then
    echo -e "${RED}Error: Certificate files not found in $CERT_SOURCE${NC}"
    exit 1
fi

cp "$CERT_SOURCE/fullchain.pem" "$SSL_DIR/"
cp "$CERT_SOURCE/privkey.pem" "$SSL_DIR/"

# Set appropriate permissions
chmod 644 "$SSL_DIR/fullchain.pem"
chmod 600 "$SSL_DIR/privkey.pem"

# Get the current user (if running via sudo)
if [ -n "$SUDO_USER" ]; then
    chown "$SUDO_USER:$SUDO_USER" "$SSL_DIR"/*.pem
else
    chown "$USER:$USER" "$SSL_DIR"/*.pem
fi

echo -e "${GREEN}Certificates copied to $SSL_DIR${NC}"
echo ""

# Restart nginx container
echo "Starting nginx container..."
cd "$COMPOSE_DIR"
docker compose -f nginx.yml start nginx

if [ $? -eq 0 ]; then
    echo -e "${GREEN}Nginx container started successfully${NC}"
else
    echo -e "${YELLOW}Warning: Failed to start nginx container. Please start it manually${NC}"
fi

echo ""
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}SSL Certificate Setup Complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Verify HTTPS is working: curl -I https://$DOMAIN"
echo "2. Test in browser: https://$DOMAIN"
echo "3. Set up auto-renewal: See renew-ssl-cert.sh and add to crontab"
echo ""
echo -e "${YELLOW}Important:${NC} Ensure the HTTP to HTTPS redirect is enabled in nginx-prod.conf"
echo "The redirect should be uncommented in the HTTP server block"
echo ""

