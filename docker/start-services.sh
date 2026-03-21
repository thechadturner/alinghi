#!/bin/bash
# Start All RaceSight Services
# This script starts all Docker services for the RaceSight application

set -e

echo "============================================"
echo "  Starting RaceSight Services"
echo "============================================"
echo

# Get script directory and base path
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_PATH="$(dirname "$SCRIPT_DIR")"

# If script is in docker/ directory, go up one level
if [[ "$SCRIPT_DIR" == *"/docker" ]]; then
    BASE_PATH="$(dirname "$BASE_PATH")"
fi

# Default to /home/racesight/racesight if BASE_PATH doesn't look right (legacy installs may use .../hunico)
if [[ ! "$BASE_PATH" == *"hunico"* ]] && [[ ! "$BASE_PATH" == *"/racesight/racesight"* ]]; then
    BASE_PATH="/home/racesight/racesight"
fi

cd "$BASE_PATH" || {
    echo "[ERROR] Cannot access base directory: $BASE_PATH"
    exit 1
}

echo "[INFO] Base directory: $BASE_PATH"
echo

# Check if docker-compose.yml exists
if [ ! -f "docker-compose.yml" ]; then
    echo "[ERROR] docker-compose.yml not found in $BASE_PATH"
    echo "[INFO] Make sure you have deployed the servers using DEPLOY_SERVERS.bat"
    exit 1
fi

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "[ERROR] Docker is not running or current user doesn't have permission"
    echo "[INFO] Try: sudo systemctl start docker"
    echo "[INFO] Or run this script with sudo"
    exit 1
fi

# Check for docker-compose command
if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
elif docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
else
    echo "[ERROR] docker-compose not found"
    echo "[INFO] Please install docker-compose"
    exit 1
fi

echo "[INFO] Using: $COMPOSE_CMD"
echo

# Create Docker network if it doesn't exist
echo "[INFO] Ensuring Docker network exists..."
docker network create hunico-network 2>/dev/null || echo "[INFO] Network already exists"
echo

# Start services
echo "[INFO] Starting all services..."
echo "[INFO] This may take several minutes on first run (building images)..."
echo

$COMPOSE_CMD -f docker-compose.yml up -d --build

if [ $? -eq 0 ]; then
    echo
    echo "[SUCCESS] Services started!"
    echo
    echo "[INFO] Waiting for services to be ready..."
    sleep 5
    
    echo
    echo "[INFO] Service status:"
    $COMPOSE_CMD -f docker-compose.yml ps
    
    echo
    echo "[INFO] To view logs:"
    echo "  $COMPOSE_CMD -f docker-compose.yml logs -f"
    echo
    echo "[INFO] To stop services:"
    echo "  $COMPOSE_CMD -f docker-compose.yml down"
    echo "  Or run: bash stop-services.sh"
    echo
else
    echo
    echo "[ERROR] Failed to start services"
    echo "[INFO] Check logs with: $COMPOSE_CMD -f docker-compose.yml logs"
    exit 1
fi

