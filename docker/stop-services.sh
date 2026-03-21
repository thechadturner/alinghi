#!/bin/bash
# Stop All Hunico Services
# This script stops all Docker services for the Hunico application

set -e

echo "============================================"
echo "  Stopping Hunico Services"
echo "============================================"
echo

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

echo "[INFO] Stopping all services..."
$COMPOSE_CMD -f docker-compose.yml down

if [ $? -eq 0 ]; then
    echo
    echo "[SUCCESS] Services stopped"
    echo
else
    echo
    echo "[ERROR] Failed to stop services"
    exit 1
fi

