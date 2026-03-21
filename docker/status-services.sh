#!/bin/bash
# Check Status of Hunico Services
# This script shows the status of all Docker services

# Get script directory and base path
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_PATH="$(dirname "$SCRIPT_DIR")"

# If script is in docker/ directory, go up one level
if [[ "$SCRIPT_DIR" == *"/docker" ]]; then
    BASE_PATH="$(dirname "$BASE_PATH")"
fi

# Default to /home/racesight/hunico if BASE_PATH doesn't look right
if [[ ! "$BASE_PATH" == *"hunico"* ]]; then
    BASE_PATH="/home/racesight/hunico"
fi

cd "$BASE_PATH" || {
    echo "[ERROR] Cannot access base directory: $BASE_PATH"
    exit 1
}

# Check for docker-compose command
if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
elif docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
else
    echo "[ERROR] docker-compose not found"
    exit 1
fi

echo "============================================"
echo "  Hunico Services Status"
echo "============================================"
echo

if [ -f "docker-compose.yml" ]; then
    $COMPOSE_CMD -f docker-compose.yml ps
    echo
    echo "[INFO] Service health:"
    $COMPOSE_CMD -f docker-compose.yml ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
else
    echo "[ERROR] docker-compose.yml not found in $BASE_PATH"
    exit 1
fi

echo
echo "[INFO] To view logs: $COMPOSE_CMD -f docker-compose.yml logs -f [service_name]"
echo "[INFO] To restart: bash restart-services.sh"
echo

