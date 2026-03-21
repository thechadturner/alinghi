#!/bin/bash
# Check environment variables on VM
# Run this on the VM to verify .env.production is correct

echo "============================================"
echo "  Checking Environment Configuration"
echo "============================================"
echo

BASE_PATH="${1:-/home/racesight/hunico}"
cd "$BASE_PATH" || {
    echo "[ERROR] Cannot access: $BASE_PATH"
    exit 1
}

echo "[INFO] Base path: $BASE_PATH"
echo

# Check if .env.production exists
if [ -f .env.production ]; then
    echo "[SUCCESS] .env.production exists"
    echo "[INFO] DB_NAME in .env.production:"
    grep "^DB_NAME=" .env.production || echo "  DB_NAME not found"
    echo
    echo "[INFO] DB_HOST in .env.production:"
    grep "^DB_HOST=" .env.production || echo "  DB_HOST not found"
    echo
else
    echo "[ERROR] .env.production not found in $BASE_PATH"
    exit 1
fi

# Check if docker-compose.yml exists
if [ -f docker-compose.yml ]; then
    echo "[SUCCESS] docker-compose.yml exists"
else
    echo "[ERROR] docker-compose.yml not found in $BASE_PATH"
    exit 1
fi

# Check environment variables in running container
if docker ps | grep -q hunico-node; then
    echo
    echo "[INFO] Environment variables in running container:"
    echo "DB_NAME: $(docker exec hunico-node sh -c 'echo $DB_NAME')"
    echo "DB_HOST: $(docker exec hunico-node sh -c 'echo $DB_HOST')"
    echo "DB_USER: $(docker exec hunico-node sh -c 'echo $DB_USER')"
    echo "REDIS_HOST: $(docker exec hunico-node sh -c 'echo $REDIS_HOST')"
else
    echo
    echo "[WARNING] hunico-node container is not running"
    echo "[INFO] Start it with: docker-compose -f docker-compose.yml up -d"
fi

echo
echo "============================================"
