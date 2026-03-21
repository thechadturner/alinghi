#!/bin/bash
# Restart All RaceSight Services
# This script restarts all Docker services for the RaceSight application

set -e

echo "============================================"
echo "  Restarting RaceSight Services"
echo "============================================"
echo

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Stop services first
echo "[INFO] Stopping services..."
bash "$SCRIPT_DIR/stop-services.sh"

echo
echo "[INFO] Waiting 3 seconds before restarting..."
sleep 3

echo
# Start services
echo "[INFO] Starting services..."
bash "$SCRIPT_DIR/start-services.sh"

