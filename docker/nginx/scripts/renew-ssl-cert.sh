#!/bin/bash

# Script to renew SSL certificates and reload Docker nginx
# This script should be run via cron for automatic renewal

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="racesight.cloud"
SSL_DIR="$(dirname "$0")/../ssl"
COMPOSE_DIR="$(dirname "$0")/../../compose"
LOG_FILE="/var/log/certbot-renewal.log"

# Function to log messages
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "Starting SSL certificate renewal process..."

# Check if running as root (required for Certbot)
if [ "$EUID" -ne 0 ]; then 
    log "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    log "Error: Docker is not running"
    exit 1
fi

# Check if certificates need renewal (Certbot only renews if within 30 days of expiration)
log "Checking certificate expiration..."

# Attempt renewal
if certbot renew --quiet --no-random-sleep-on-renew; then
    log "Certificate renewal check completed"
    
    # Check if certificates were actually renewed
    CERT_SOURCE="/etc/letsencrypt/live/$DOMAIN"
    
    if [ -f "$CERT_SOURCE/fullchain.pem" ] && [ -f "$CERT_SOURCE/privkey.pem" ]; then
        # Compare certificate modification times
        SOURCE_TIME=$(stat -c %Y "$CERT_SOURCE/fullchain.pem" 2>/dev/null || echo 0)
        DEST_TIME=$(stat -c %Y "$SSL_DIR/fullchain.pem" 2>/dev/null || echo 0)
        
        # If source is newer, certificates were renewed
        if [ "$SOURCE_TIME" -gt "$DEST_TIME" ]; then
            log "Certificates were renewed. Copying to Docker nginx SSL directory..."
            
            # Stop nginx container (required for Certbot standalone mode if renewal uses it)
            cd "$COMPOSE_DIR"
            docker compose -f nginx.yml stop nginx 2>/dev/null || true
            sleep 2
            
            # Copy renewed certificates
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
            
            log "Certificates copied successfully"
            
            # Reload nginx container to use new certificates
            log "Reloading nginx container..."
            docker compose -f nginx.yml start nginx
            
            # Test nginx configuration
            if docker exec nginx nginx -t > /dev/null 2>&1; then
                docker exec nginx nginx -s reload
                log "Nginx reloaded successfully with new certificates"
            else
                log "Warning: Nginx configuration test failed. Please check manually"
            fi
            
            log "Certificate renewal completed successfully"
        else
            log "Certificates are still valid, no renewal needed"
        fi
    else
        log "Warning: Certificate files not found in $CERT_SOURCE"
    fi
else
    log "Error: Certificate renewal failed"
    exit 1
fi

log "SSL certificate renewal process completed"
echo ""

