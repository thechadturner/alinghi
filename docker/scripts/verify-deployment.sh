#!/bin/bash
# Verify Docker Deployment - Check if environment variables are loaded correctly

echo "============================================"
echo "  Verifying Docker Deployment"
echo "============================================"
echo

# Check if container is running
if ! docker ps | grep -q hunico-node; then
    echo "[ERROR] hunico-node container is not running"
    exit 1
fi

echo "[INFO] Checking environment variables in hunico-node container..."
echo

# Check DB_NAME
DB_NAME=$(docker exec hunico-node sh -c 'echo $DB_NAME')
echo "DB_NAME: ${DB_NAME:-<not set>}"

# Check DB_HOST
DB_HOST=$(docker exec hunico-node sh -c 'echo $DB_HOST')
echo "DB_HOST: ${DB_HOST:-<not set>}"

# Check DB_USER
DB_USER=$(docker exec hunico-node sh -c 'echo $DB_USER')
echo "DB_USER: ${DB_USER:-<not set>}"

# Check REDIS_HOST
REDIS_HOST=$(docker exec hunico-node sh -c 'echo $REDIS_HOST')
echo "REDIS_HOST: ${REDIS_HOST:-<not set>}"

echo
echo "[INFO] Checking .env.production file on VM..."
if [ -f .env.production ]; then
    echo "[SUCCESS] .env.production exists"
    echo "[INFO] DB_NAME in .env.production:"
    grep "^DB_NAME=" .env.production || echo "  DB_NAME not found in .env.production"
else
    echo "[WARNING] .env.production not found in current directory"
fi

echo
echo "[INFO] Testing database connection..."
docker exec hunico-node node -e "
const {Pool} = require('pg');
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true'
});
pool.query('SELECT 1', (err, res) => {
    if (err) {
        console.error('Database connection error:', err.message);
        process.exit(1);
    } else {
        console.log('Database connection: SUCCESS');
        process.exit(0);
    }
});
"

echo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/quick-restart-connectivity.sh" ]; then
    echo "[INFO] Mounts + /api/ready (shared with QUICK_RESTART_VM_SERVICES.bat)..."
    bash "${SCRIPT_DIR}/quick-restart-connectivity.sh" || exit 1
else
    echo "[WARNING] quick-restart-connectivity.sh not found in ${SCRIPT_DIR} — skipping mount/ready checks"
fi

echo
echo "[INFO] Testing Redis connection..."
docker exec hunico-node node -e "
const Redis = require('ioredis');
const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD || undefined,
    db: process.env.REDIS_DB || 0
});
redis.ping().then(() => {
    console.log('Redis connection: SUCCESS');
    process.exit(0);
}).catch((err) => {
    console.error('Redis connection error:', err.message);
    process.exit(1);
});
"

echo
echo "[INFO] Checking InfluxDB configuration in hunico-python container..."
if docker ps | grep -q hunico-python; then
    INFLUX_HOST=$(docker exec hunico-python sh -c 'echo $INFLUX_HOST' 2>/dev/null)
    INFLUX_TOKEN=$(docker exec hunico-python sh -c 'echo $INFLUX_TOKEN' 2>/dev/null)
    INFLUX_DATABASE=$(docker exec hunico-python sh -c 'echo $INFLUX_DATABASE' 2>/dev/null)
    INFLUX_BUCKET=$(docker exec hunico-python sh -c 'echo $INFLUX_BUCKET' 2>/dev/null)
    
    echo "INFLUX_HOST: ${INFLUX_HOST:-<not set>}"
    echo "INFLUX_DATABASE: ${INFLUX_DATABASE:-<not set>}"
    echo "INFLUX_BUCKET: ${INFLUX_BUCKET:-<not set>}"
    echo "INFLUX_TOKEN: ${INFLUX_TOKEN:+<set>}${INFLUX_TOKEN:-<not set>}"
    
    if [ -z "$INFLUX_HOST" ] || [ -z "$INFLUX_TOKEN" ] || [ -z "$INFLUX_BUCKET" ]; then
        echo "[WARNING] InfluxDB configuration is incomplete"
        echo "[INFO] Required variables: INFLUX_HOST, INFLUX_TOKEN, INFLUX_BUCKET"
        echo "[INFO] These should be set in .env.production.local"
    else
        echo "[SUCCESS] InfluxDB configuration appears complete"
    fi
else
    echo "[WARNING] hunico-python container is not running"
fi

echo
echo "============================================"
echo "  Verification Complete"
echo "============================================"
