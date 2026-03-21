#!/bin/bash
# VM Setup Script for Hunico Production Deployment
# This script sets up the initial directory structure and Docker network on the VM
# Run this once on the VM, or as part of the deployment process

set -e

echo "============================================"
echo "  Hunico VM Setup Script"
echo "============================================"
echo

# Configuration (can be overridden by environment variables)
BASE_PATH="${VM_BASE_PATH:-/home/racesight/hunico}"
FRONTEND_PATH="${VM_FRONTEND_PATH:-$BASE_PATH/frontend}"
SERVERS_PATH="${VM_SERVERS_PATH:-$BASE_PATH/servers}"
DATA_PATH="${VM_DATA_PATH:-$BASE_PATH/data}"
MEDIA_PATH="${VM_MEDIA_PATH:-$BASE_PATH/media}"
SCRIPTS_PATH="${VM_SCRIPTS_PATH:-/opt/hunico/scripts}"
DOCKER_NETWORK="${DOCKER_NETWORK_NAME:-hunico-network}"

echo "[INFO] Base path: $BASE_PATH"
echo "[INFO] Frontend path: $FRONTEND_PATH"
echo "[INFO] Servers path: $SERVERS_PATH"
echo "[INFO] Data path: $DATA_PATH"
echo "[INFO] Media path: $MEDIA_PATH"
echo "[INFO] Scripts path: $SCRIPTS_PATH"
echo "[INFO] Docker network: $DOCKER_NETWORK"
echo

# Step 1: Create directory structure
echo "[INFO] Step 1: Creating directory structure..."
mkdir -p "$BASE_PATH"
mkdir -p "$FRONTEND_PATH"
mkdir -p "$SERVERS_PATH"
mkdir -p "$DATA_PATH"
mkdir -p "$MEDIA_PATH"
mkdir -p "$SCRIPTS_PATH"
echo "[SUCCESS] Directories created"
echo

# Step 2: Set permissions
echo "[INFO] Step 2: Setting permissions..."
chmod 755 "$BASE_PATH"
chmod 755 "$FRONTEND_PATH"
chmod 755 "$SERVERS_PATH"
chmod 755 "$DATA_PATH"
chmod 755 "$MEDIA_PATH"
chmod 755 "$SCRIPTS_PATH"
echo "[SUCCESS] Permissions set"
echo

# Step 3: Create Docker network
echo "[INFO] Step 3: Creating Docker network..."
if docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1; then
    echo "[INFO] Docker network '$DOCKER_NETWORK' already exists"
else
    docker network create "$DOCKER_NETWORK" 2>/dev/null || {
        echo "[WARNING] Failed to create Docker network (may already exist or Docker not running)"
    }
    echo "[SUCCESS] Docker network created"
fi
echo

# Step 4: Verify Docker is accessible
echo "[INFO] Step 4: Verifying Docker..."
if command -v docker >/dev/null 2>&1; then
    docker --version
    echo "[SUCCESS] Docker is accessible"
else
    echo "[ERROR] Docker command not found. Please install Docker."
    exit 1
fi
echo

# Step 5: Verify docker-compose is accessible
echo "[INFO] Step 5: Verifying docker-compose..."
if command -v docker-compose >/dev/null 2>&1 || docker compose version >/dev/null 2>&1; then
    if command -v docker-compose >/dev/null 2>&1; then
        docker-compose --version
    else
        docker compose version
    fi
    echo "[SUCCESS] docker-compose is accessible"
else
    echo "[WARNING] docker-compose command not found. You may need to install docker-compose."
fi
echo

echo "============================================"
echo "  VM Setup Complete"
echo "============================================"
echo
echo "[INFO] Directory structure:"
echo "  - Base: $BASE_PATH"
echo "  - Frontend: $FRONTEND_PATH"
echo "  - Servers: $SERVERS_PATH"
echo "  - Data: $DATA_PATH"
echo "  - Media: $MEDIA_PATH"
echo "  - Scripts: $SCRIPTS_PATH"
echo
echo "[INFO] Next steps:"
echo "  1. Deploy frontend: Run DEPLOY_FRONTEND.bat from your local machine"
echo "  2. Deploy servers: Run DEPLOY_SERVERS.bat from your local machine"
echo "  3. Start services: cd $BASE_PATH && docker-compose -f docker-compose.yml up -d"
echo

